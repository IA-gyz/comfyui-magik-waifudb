import asyncio
import sqlite3
import json
import os
import re
from collections import defaultdict
from functools import wraps, lru_cache
from types import SimpleNamespace
from pathlib import Path
from aiohttp import web
from server import PromptServer

from comfy_api.latest import io

DB_PATH = os.path.join(os.path.dirname(__file__), "character_db_modular.sqlite")

# ---------------------------------------------------------------------------
# Schema version check — runs at import and refreshes after database changes.
# Prints a clear error to the ComfyUI console if the DB is outdated so the
# user knows to re-run csv2sqlite.py rather than seeing cryptic 500 errors.
# ---------------------------------------------------------------------------

_REQUIRED_COLUMNS = {
    "characters": {"breast_size", "eye_color", "hair_color_1", "hair_color_2",
                   "hairstyle_1", "hairstyle_2", "hairstyle_3", "hairstyle_4",
                   "thumbnail_path", "post_count", "char_id", "original_input", "danbooru_tag"},
    "series": {"series_id", "name"},
    "traits": {"trait_id", "category", "name"},
    "character_series": {"char_id", "series_id"},
    "character_traits": {"char_id", "trait_id"},
}
_REQUIRED_TABLES = {"characters", "series", "traits", "character_series",
                    "character_traits", "characters_fts"}

def _check_schema() -> bool:
    if not os.path.isfile(DB_PATH):
        return False
    conn = None
    try:
        conn = sqlite3.connect(Path(DB_PATH).resolve().as_uri() + "?mode=rw", uri=True)
        tables = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table','shadow')"
        )}
        missing_tables = _REQUIRED_TABLES - tables
        if missing_tables:
            print(f"\n[WaifuDB] ⚠ DB schema is outdated — missing: {missing_tables}")
            print("[WaifuDB] ⚠ Please re-run csv2sqlite.py to rebuild the database.\n")
            conn.close()
            return False
        for table, cols in _REQUIRED_COLUMNS.items():
            existing = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
            missing_cols = cols - existing
            if missing_cols:
                print(f"\n[WaifuDB] ⚠ Table '{table}' missing columns: {missing_cols}")
                print("[WaifuDB] ⚠ Please re-run csv2sqlite.py to rebuild the database.\n")
                conn.close()
                return False
        fts_sql = conn.execute("SELECT sql FROM sqlite_master WHERE name='characters_fts'").fetchone()[0] or ""
        if "fts5" not in fts_sql.lower() or "trigram" not in fts_sql.lower():
            print("[WaifuDB] characters_fts must use FTS5 with the trigram tokenizer")
            return False
        conn.execute("SELECT rowid FROM characters_fts WHERE characters_fts MATCH ? LIMIT 1", ('"schema_probe"',)).fetchall()
        return True
    except Exception as e:
        print(f"[WaifuDB] ⚠ Could not verify DB schema: {e}")
        return False
    finally:
        if conn is not None:
            conn.close()

DB_SCHEMA_OK = _check_schema()
def _db_signature():
    try:
        stat = os.stat(DB_PATH)
        return (stat.st_ino, stat.st_size, stat.st_mtime_ns)
    except OSError:
        return None
_SCHEMA_SIGNATURE = _db_signature()
def schema_ready():
    global DB_SCHEMA_OK, _SCHEMA_SIGNATURE
    signature = _db_signature()
    if signature != _SCHEMA_SIGNATURE:
        DB_SCHEMA_OK = _check_schema()
        _SCHEMA_SIGNATURE = signature
        if DB_SCHEMA_OK:
            _ensure_indexes()
    return DB_SCHEMA_OK and signature is not None


def _ensure_indexes():
    """Create runtime indexes that csv2sqlite.py may have omitted."""
    conn = None
    try:
        conn = sqlite3.connect(Path(DB_PATH).resolve().as_uri() + "?mode=rw", uri=True)
        conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_traits_category_name
            ON traits(category, name)
        """)
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[WaifuDB] Could not create traits index: {e}")
    finally:
        if conn is not None:
            conn.close()

if DB_SCHEMA_OK:
    _ensure_indexes()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_ALLOWED_DISTINCT_COLS = {"breast_size", "eye_color", "hair_color_1", "hair_color_2",
                         "hairstyle_1", "hairstyle_2", "hairstyle_3", "hairstyle_4"}

def get_db_connection():
    if not os.path.isfile(DB_PATH):
        raise RuntimeError("WaifuDB database file is missing")
    conn = sqlite3.connect(Path(DB_PATH).resolve().as_uri() + "?mode=rw", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def fts5_escape(q: str) -> str:
    """
    Wrap a user query in FTS5 double-quote syntax so every character is
    treated literally.  The only special char inside a quoted phrase is "
    itself, which must be doubled.
    """
    return '"' + q.replace('"', '""') + '"'


def assemble_char(c, cats: dict) -> dict:
    """Build the standard character dict from a DB row + grouped trait dict."""
    def join_tags(lst): return ", ".join(lst) if lst else ""
    clothing = cats.get("clothing", [])
    return {
        "char_id":              str(c["char_id"]),
        "original_input":       c["original_input"] or "",
        "danbooru_tag":         c["danbooru_tag"] or "",
        "breast_size":          c["breast_size"] or "",
        "eye_color":            c["eye_color"] or "",
        "hair_color_1":         c["hair_color_1"] or "",
        "hair_color_2":         c["hair_color_2"] or "",
        "hairstyle_1":          c["hairstyle_1"] or "",
        "hairstyle_2":          c["hairstyle_2"] or "",
        "hairstyle_3":          c["hairstyle_3"] or "",
        "hairstyle_4":          c["hairstyle_4"] or "",
        "common_outfits":       join_tags(clothing[:3]),
        "clothing_pieces":      join_tags(clothing[3:]),
        "clothing_accessories": join_tags(cats.get("accessory", [])),
        "others":               join_tags(cats.get("other", [])),
        "thumbnail_path":       c["thumbnail_path"] or "",
        "nl_girl_description": c["nl_girl_description"] or "" if "nl_girl_description" in c.keys() else "",
        "nl_clothing": c["nl_clothing"] or "" if "nl_clothing" in c.keys() else "",
    }


def fetch_tier2_traits(conn, char_ids: list) -> dict:
    """Return {char_id: {category: [name, ...]}} for a list of char_ids."""
    if not char_ids:
        return {}
    ph = ",".join("?" * len(char_ids))
    trait_rows = conn.execute(f"""
        SELECT ct.char_id, t.category, t.name
        FROM character_traits ct
        JOIN traits t ON ct.trait_id = t.trait_id
        WHERE ct.char_id IN ({ph})
        ORDER BY t.name
    """, char_ids).fetchall()
    result = defaultdict(lambda: defaultdict(list))
    for t in trait_rows:
        result[t["char_id"]][t["category"]].append(t["name"])
    return result


def random_filter_query(filters=None):
    filters = {} if filters is None else filters
    if not isinstance(filters, dict):
        raise ValueError("Random character filters must be an object")
    for key in ("series", "breast_size", "eye_color", "hair_color", "hairstyle"):
        if key in filters and not isinstance(filters[key], str):
            raise ValueError(f"Random filter {key} must be a string")
    conditions, params = [], []
    pool = filters.get("pool", "all")
    if pool not in ("all", "favorites", "my_waifus"):
        raise ValueError("Unknown random character pool")
    if pool != "all":
        ids = filters.get("ids", [])
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            raise ValueError("Favorite character IDs must be a string list")
        if not ids:
            return "0", []
        # One bound JSON parameter also supports large favorite lists.
        conditions.append("CAST(c.char_id AS TEXT) IN (SELECT value FROM json_each(?))")
        params.append(json.dumps(ids))
    series = filters.get("series", "")
    if series:
        conditions.append("EXISTS (SELECT 1 FROM character_series cs JOIN series s ON cs.series_id = s.series_id WHERE cs.char_id = c.char_id AND s.name = ?)")
        params.append(series)
    for key in ("breast_size", "eye_color"):
        value = filters.get(key, "")
        if value:
            conditions.append(f"c.{key} = ?")
            params.append(value)
    if filters.get("hair_color"):
        conditions.append("(c.hair_color_1 = ? OR c.hair_color_2 = ?)")
        params.extend([filters["hair_color"]] * 2)
    if filters.get("hairstyle"):
        conditions.append("(" + " OR ".join(f"c.hairstyle_{i} = ?" for i in range(1, 5)) + ")")
        params.extend([filters["hairstyle"]] * 4)
    where = " AND ".join(conditions) if conditions else "1"
    return where, params


def count_random_characters(filters=None):
    if not os.path.isfile(DB_PATH) or not schema_ready():
        raise RuntimeError("WaifuDB database is missing or its schema is outdated")
    where, params = random_filter_query(filters)
    conn = get_db_connection()
    try:
        return conn.execute(f"SELECT COUNT(*) FROM characters c WHERE {where}", params).fetchone()[0]
    finally:
        conn.close()


def get_random_character(filters=None):
    """Synchronous provider for prompt nodes; one full database record per run."""
    if not os.path.isfile(DB_PATH):
        raise RuntimeError("WaifuDB database file is missing")
    if not schema_ready():
        raise RuntimeError("WaifuDB database schema is outdated; rebuild with csv2sqlite.py")
    conn = None
    try:
        conn = get_db_connection()
        where, params = random_filter_query(filters)
        # Draw from every eligible character, with no search-result cap or
        # series-join duplication that could bias selection probability.
        row = conn.execute(f"""
            SELECT * FROM characters WHERE rowid = (
                SELECT c.rowid FROM characters c WHERE {where}
                ORDER BY RANDOM() LIMIT 1
            )
        """, params).fetchone()
        if row is None:
            raise RuntimeError("No characters match the random selection filters")
        traits = fetch_tier2_traits(conn, [row["char_id"]])
        return assemble_char(row, traits.get(row["char_id"], {}))
    finally:
        if conn is not None:
            conn.close()


def threaded_route(handler):
    """Run blocking SQLite handlers off the server loop using immutable request data."""
    @wraps(handler)
    async def wrapped(request):
        body, body_error = None, None
        if handler.__name__ == "char_update":
            try:
                body = await request.json()
            except Exception as error:
                body_error = error
        async def read_json():
            if body_error is not None:
                raise body_error
            return body
        snapshot = SimpleNamespace(query=dict(request.query), match_info=dict(request.match_info), json=read_json)
        return await asyncio.to_thread(lambda: asyncio.run(handler(snapshot)))
    return wrapped


def get_character_by_index(index):
    """Zero-based position in the characters table ordered by its stable ID."""
    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
        raise ValueError("Index override must be a non-negative integer")
    if not schema_ready():
        raise RuntimeError("WaifuDB database is missing or its schema is outdated")
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT * FROM characters ORDER BY char_id ASC LIMIT 1 OFFSET ?", (index,)).fetchone()
        if row is None:
            count = conn.execute("SELECT COUNT(*) FROM characters").fetchone()[0]
            raise ValueError(f"Index override {index} is out of range: database contains {count} characters (zero-based indexing)")
        traits = fetch_tier2_traits(conn, [row["char_id"]])
        return assemble_char(row, traits.get(row["char_id"], {}))
    finally:
        conn.close()


def build_character_prompt(character):
    """Full database prompt, without browser-only category choices or overrides."""
    fields = ["danbooru_tag", "breast_size", "eye_color", "hair_color_1"]
    hair_traits = " ".join(character.get(key, "") for key in
                           ("hairstyle_1", "hairstyle_2", "hairstyle_3", "hairstyle_4", "others")).lower().replace("_", " ")
    if "multicolored hair" in hair_traits:
        fields.append("hair_color_2")
    fields.extend(["hairstyle_1", "hairstyle_2", "hairstyle_3", "hairstyle_4",
                   "common_outfits", "clothing_pieces", "clothing_accessories", "others"])
    tags, seen = [], set()
    for field in fields:
        for raw in (character.get(field) or "").split(","):
            tag = raw.strip().replace("(", "\\(").replace(")", "\\)").replace("_", " ")
            if tag and tag not in seen:
                seen.add(tag)
                tags.append(tag)
    if any(tag.lower() == "long hair" for tag in tags):
        tags = [tag for tag in tags if tag.lower() != "short hair"]
    return ", ".join(tags)


# Conservative tag classification: unknown accessory/body tags are excluded.
_FACE_WORDS = re.compile(
    r"\b(hair|hairstyle|bangs|braids?|ponytails?|twintails?|pigtails?|ahoge|"
    r"eyes?|eyebrows?|eyelashes?|eyelids?|pupils?|iris|irises|heterochromia|"
    r"face|facial|cheeks?|chin|jaw|nose|nostrils?|lips?|mouth|teeth|fangs?|tongue|"
    r"ears?|elf ears|horns?|antlers?|makeup|eyeshadow|eyeliner|mascara|lipstick|"
    r"blush|freckles|beard|mustache|moustache|sideburns|smile|smiling|grin|"
    r"frown|pout|wink|winking|crying|tears|head|headwear|headgear|hat|cap|"
    r"beret|bonnet|hood|helmet|crown|tiara|diadem|headband|hairband|hairclip|"
    r"hairpin|hair ornament|hair ribbon|hair bow|headdress|earrings?|ear cuffs?|"
    r"glasses|eyeglasses|sunglasses|goggles|monocle|eyepatch|mask|veil|"
    r"headphones|earphones|earbuds|bald|balding|bob cut|hime cut|pixie cut|"
    r"dreadlocks|cornrows|chignon|bun|buns)\b", re.IGNORECASE)
_BODY_OR_CLOTHES = re.compile(
    r"\b(breasts?|chest|cleavage|bust|nipples?|areolae?|torso|waist|hips?|"
    r"thighs?|legs?|feet|foot|arms?|hands?|navel|belly|abdomen|butt|buttocks|"
    r"body|dress|shirt|blouse|skirt|pants|trousers|shorts|leggings|stockings|"
    r"socks|shoes|boots|gloves|bikini|swimsuit|underwear|panties|bra|lingerie|"
    r"jacket|coat|cape|uniform|outfit|bodysuit|leotard|apron|armor|belt|"
    r"necklace|choker|bracelet|anklet|tail|wings)\b", re.IGNORECASE)
_NON_HEAD_HAIR = re.compile(r"\b(pubic|armpit|underarm|chest|body|leg|arm) hair\b", re.IGNORECASE)


def build_face_prompt(prompt, identity_tags=None):
    """Keep identity and recognized head tags in each character's prompt block.

    Database identities are explicit. Manual prompt blocks follow the panel's
    identity-first format; their first tag is kept unless recognizably a body
    or clothing tag. Unknown subsequent tags are intentionally excluded.
    """
    identities = {tag.strip().lower().replace("_", " ") for tag in (identity_tags or []) if tag}
    blocks = []
    for block in re.split(r"\n\s*\n", prompt or ""):
        kept, seen = [], set()
        for index, raw in enumerate(block.split(",")):
            tag = raw.strip()
            if not tag:
                continue
            normalized = tag.lower().replace("_", " ")
            known_identity = normalized in identities
            excluded = bool(_BODY_OR_CLOTHES.search(normalized) or _NON_HEAD_HAIR.search(normalized))
            identity = known_identity or (identity_tags is None and index == 0 and not excluded)
            if identity or (not excluded and _FACE_WORDS.search(normalized)):
                if normalized not in seen:
                    seen.add(normalized)
                    kept.append(tag)
        if kept:
            blocks.append(", ".join(kept))
    return ",\n\n".join(blocks)


# Register the callable after the module loads. Prompt nodes resolve it at
# execution time, so custom-node import order and install folder names do not
# matter. No HTTP round trip or second copy of WaifuDB is needed.
def lookup_character_picture(name):
    """Exact identity lookup; never choose an unrelated fuzzy result."""
    if not os.path.isfile(DB_PATH) or not schema_ready():
        return None
    identity = str(name or '').replace('\\(', '(').replace('\\)', ')').replace('_', ' ')
    identity = ' '.join(identity.split())
    if not identity:
        return None
    conn = get_db_connection()
    try:
        rows = conn.execute("""SELECT char_id, thumbnail_path FROM characters
            WHERE lower(replace(danbooru_tag, '_', ' ')) = lower(?)
               OR lower(replace(original_input, '_', ' ')) = lower(?)
            ORDER BY char_id LIMIT 2""", (identity, identity)).fetchall()
        # Ambiguous identities must not display the wrong character.
        if len(rows) != 1 or not rows[0]['thumbnail_path']:
            return None
        return str(rows[0]['char_id'])
    finally:
        conn.close()


PromptServer.instance.magik_waifudb_character_picture = lookup_character_picture

PromptServer.instance.magik_waifudb_random_character = get_random_character


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@PromptServer.instance.routes.post("/custom_character_search/random_count")
async def random_character_count(request):
    import asyncio
    try:
        filters = await request.json()
        count = await asyncio.to_thread(count_random_characters, filters)
        return web.json_response({"count": count})
    except (ValueError, TypeError) as error:
        return web.json_response({"error": str(error)}, status=400)
    except Exception as error:
        return web.json_response({"error": str(error)}, status=503)


@PromptServer.instance.routes.get("/custom_character_search/filters")
@threaded_route
async def get_filters(request):
    if not schema_ready():
        return web.json_response(
            {"error": "Database schema is outdated. Please re-run csv2sqlite.py."},
            status=503
        )

    """
    Return series list + all distinct Tier-1 scalar values for the trait
    filter panel dropdowns.
    """
    conn = None
    try:
        conn = get_db_connection()

        series = [
            {"name": r[0], "count": r[1]}
            for r in conn.execute("""
                SELECT s.name, COUNT(cs.char_id) as cnt
                FROM series s
                LEFT JOIN character_series cs ON s.series_id = cs.series_id
                GROUP BY s.series_id
                ORDER BY s.name
            """)
        ]

        def distinct_vals(col):
            if col not in _ALLOWED_DISTINCT_COLS:
                raise ValueError(f"Invalid column for distinct_vals: {col}")
            return [r[0] for r in conn.execute(f"""
                SELECT {col}, COUNT(*) as n FROM characters
                WHERE {col} IS NOT NULL
                GROUP BY {col} ORDER BY n DESC
            """)]

        # Hairstyle values span four slots — union them all
        hairstyle_vals = sorted({
            r[0]
            for slot in ("hairstyle_1","hairstyle_2","hairstyle_3","hairstyle_4")
            for r in conn.execute(
                f"SELECT DISTINCT {slot} FROM characters WHERE {slot} IS NOT NULL"
            )
        })

        return web.json_response({
            "series":      series,
            "breast_size": distinct_vals("breast_size"),
            "eye_color":   distinct_vals("eye_color"),
            "hair_color": sorted(set(distinct_vals("hair_color_1") + distinct_vals("hair_color_2")) - {""}),
            "hairstyle":   hairstyle_vals,
        })
    except Exception as e:
        print(f"[WaifuDB] /filters error: {e}")
        return web.json_response({"error": str(e)}, status=500)
    finally:
        if conn:
            conn.close()


@PromptServer.instance.routes.get("/custom_character_search/series_chars")
@threaded_route
async def get_series_chars(request):
    if not schema_ready():
        return web.json_response(
            {"error": "Database schema is outdated. Please re-run csv2sqlite.py."},
            status=503
        )

    """Return all characters in the requested series."""
    series_name = request.query.get("series", "").strip()
    if not series_name:
        return web.json_response({"error": "Missing series parameter"}, status=400)

    conn = None
    try:
        conn = get_db_connection()

        row = conn.execute(
            "SELECT series_id FROM series WHERE name = ?", (series_name,)
        ).fetchone()
        if not row:
            return web.json_response([])

        char_rows = conn.execute("""
            SELECT c.*
            FROM characters c
            JOIN character_series cs ON c.char_id = cs.char_id
            WHERE cs.series_id = ?
            ORDER BY c.original_input
        """, (row["series_id"],)).fetchall()

        if not char_rows:
            return web.json_response([])

        traits = fetch_tier2_traits(conn, [r["char_id"] for r in char_rows])
        return web.json_response([
            assemble_char(c, traits.get(c["char_id"], {})) for c in char_rows
        ])

    except Exception as e:
        print(f"[WaifuDB] /series_chars error: {e}")
        return web.json_response({"error": str(e)}, status=500)
    finally:
        if conn:
            conn.close()


@PromptServer.instance.routes.get("/custom_character_search/char_search")
@threaded_route
async def char_search(request):
    """
    Substring character search using FTS5 trigram index.
    Requires DB rebuilt with csv2sqlite.py (characters_fts table).
    Min query length: 3 chars (trigram requirement).
    """
    LIMIT_DEFAULT, LIMIT_MAX = 50, 100

    if not schema_ready():
        return web.json_response(
            {"error": "Database schema is outdated. Please re-run csv2sqlite.py."},
            status=503
        )

    q = request.query.get("q", "").strip()
    if len(q) < 3:
        return web.json_response([])

    try:
        limit = max(1, min(int(request.query.get("limit", LIMIT_DEFAULT)), LIMIT_MAX))
    except ValueError:
        limit = LIMIT_DEFAULT

    conn = None
    try:
        conn = get_db_connection()

        char_rows = conn.execute("""
            SELECT c.*
            FROM characters_fts
            JOIN characters c ON characters_fts.rowid = c.char_id
            WHERE characters_fts MATCH ?
            ORDER BY c.post_count DESC
            LIMIT ?
        """, (fts5_escape(q), limit)).fetchall()

        if not char_rows:
            return web.json_response([])

        traits = fetch_tier2_traits(conn, [r["char_id"] for r in char_rows])
        return web.json_response([
            assemble_char(c, traits.get(c["char_id"], {})) for c in char_rows
        ])

    except Exception as e:
        print(f"[WaifuDB] /char_search error: {e}")
        return web.json_response({"error": str(e)}, status=500)
    finally:
        if conn:
            conn.close()


@PromptServer.instance.routes.get("/custom_character_search/trait_filter")
@threaded_route
async def trait_filter(request):
    if not schema_ready():
        return web.json_response(
            {"error": "Database schema is outdated. Please re-run csv2sqlite.py."},
            status=503
        )

    """
    Return characters matching ALL supplied trait filters (AND logic).

    Query params (all optional, all exact-match):
        series      – series name
        breast_size – e.g. 'large_breasts'
        eye_color   – e.g. 'blue_eyes'
        hair_color  – matched against hair_color_1 OR hair_color_2
        hairstyle   – matched against hairstyle_1..4
        limit       – max results (default 100, max 200)

    At least one filter must be provided.
    Results are ordered by post_count DESC.
    """
    LIMIT_DEFAULT, LIMIT_MAX = 100, 200

    p = request.query
    series      = p.get("series",      "").strip()
    breast_size = p.get("breast_size", "").strip()
    eye_color   = p.get("eye_color",   "").strip()
    hair_color  = p.get("hair_color",  "").strip()
    hairstyle   = p.get("hairstyle",   "").strip()

    if not any([series, breast_size, eye_color, hair_color, hairstyle]):
        return web.json_response(
            {"error": "At least one filter is required."}, status=400
        )

    try:
        limit = max(1, min(int(p.get("limit", LIMIT_DEFAULT)), LIMIT_MAX))
    except ValueError:
        limit = LIMIT_DEFAULT

    conn = None
    try:
        conn = get_db_connection()

        # Build the WHERE clause incrementally.
        # All Tier-1 filters are direct column comparisons — no extra joins.
        # The series filter requires one join to character_series + series.
        conditions = []
        params = []

        if series:
            conditions.append("s.name = ?")
            params.append(series)

        if breast_size:
            conditions.append("c.breast_size = ?")
            params.append(breast_size)

        if eye_color:
            conditions.append("c.eye_color = ?")
            params.append(eye_color)

        if hair_color:
            # Match either hair_color_1 or hair_color_2 (character may have highlights)
            conditions.append("(c.hair_color_1 = ? OR c.hair_color_2 = ?)")
            params.extend([hair_color, hair_color])

        if hairstyle:
            # Match any of the four hairstyle slots
            conditions.append(
                "(c.hairstyle_1 = ? OR c.hairstyle_2 = ? "
                "OR c.hairstyle_3 = ? OR c.hairstyle_4 = ?)"
            )
            params.extend([hairstyle] * 4)

        where = " AND ".join(conditions)

        join_clause = "JOIN character_series cs ON c.char_id = cs.char_id JOIN series s ON cs.series_id = s.series_id" if series else ""
        char_rows = conn.execute(f"""
            SELECT c.*
            FROM characters c
            {join_clause}
            WHERE {where}
            ORDER BY c.post_count DESC
            LIMIT ?
        """, (*params, limit)).fetchall()

        if not char_rows:
            return web.json_response([])

        traits = fetch_tier2_traits(conn, [r["char_id"] for r in char_rows])
        return web.json_response([
            assemble_char(c, traits.get(c["char_id"], {})) for c in char_rows
        ])

    except Exception as e:
        print(f"[WaifuDB] /trait_filter error: {e}")
        return web.json_response({"error": str(e)}, status=500)
    finally:
        if conn:
            conn.close()


@PromptServer.instance.routes.post("/custom_character_search/char_update")
@threaded_route
async def char_update(request):
    """
    Update a character's editable fields.

    Body (JSON):
        char_id  – the character's ID
        updates  – dict of field→value for Tier-1 scalars and Tier-2 multi-value fields

    Tier-1 scalars are written directly to the characters table.
    Tier-2 multi-value fields (clothing, accessory, other) replace the
    character's existing trait rows for that category.
    """
    TIER1 = {"breast_size", "eye_color", "hair_color_1", "hair_color_2",
             "hairstyle_1", "hairstyle_2", "hairstyle_3", "hairstyle_4"}
    TIER2_MAP = {
        "common_outfits":       "clothing",
        "clothing_pieces":      "clothing",
        "clothing_accessories": "accessory",
        "others":               "other",
    }

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    if not isinstance(body, dict):
        return web.json_response({"error": "Body must be an object"}, status=400)
    char_id = body.get("char_id")
    updates = body.get("updates", {})

    if not isinstance(updates, dict):
        return web.json_response({"error": "updates must be an object"}, status=400)
    if not isinstance(char_id, (str, int)) or isinstance(char_id, bool):
        return web.json_response({"error": "Invalid char_id"}, status=400)
    if not char_id:
        return web.json_response({"error": "Missing char_id"}, status=400)

    unknown = set(updates) - TIER1 - set(TIER2_MAP)
    if unknown:
        return web.json_response({"error": "Unknown editable fields: " + ", ".join(sorted(unknown))}, status=400)
    if ("common_outfits" in updates) != ("clothing_pieces" in updates):
        return web.json_response({"error": "Send both clothing fields together"}, status=400)

    for k, v in updates.items():
        if not isinstance(v, str):
            return web.json_response(
                {"error": f"Field '{k}' must be a string, got {type(v).__name__}"},
                status=400
            )

    conn = None
    try:
        conn = get_db_connection()

        # Verify character exists
        if not conn.execute(
            "SELECT 1 FROM characters WHERE char_id = ?", (char_id,)
        ).fetchone():
            return web.json_response({"error": f"Character {char_id} not found"}, status=404)

        # ── Tier-1 scalars ────────────────────────────────────────────────
        tier1_updates = {k: v or None for k, v in updates.items() if k in TIER1}
        if tier1_updates:
            cols = ", ".join(f"{k} = ?" for k in tier1_updates)
            conn.execute(
                f"UPDATE characters SET {cols} WHERE char_id = ?",
                (*tier1_updates.values(), char_id)
            )

        # ── Tier-2 multi-value traits ─────────────────────────────────────
        # Group the two clothing columns together so we can replace the whole
        # clothing category atomically.
        tier2_by_category: dict[str, list[str]] = {}
        for col, category in TIER2_MAP.items():
            if col not in updates:
                continue
            tags = [t.strip() for t in updates[col].split(",") if t.strip()]
            tier2_by_category.setdefault(category, []).extend(tags)

        for category, tags in tier2_by_category.items():
            # Remove all existing traits for this character in this category
            conn.execute("""
                DELETE FROM character_traits
                WHERE char_id = ?
                  AND trait_id IN (
                      SELECT trait_id FROM traits WHERE category = ?
                  )
            """, (char_id, category))

            # Re-insert
            for tag in dict.fromkeys(tags):
                conn.execute(
                    "INSERT OR IGNORE INTO traits (category, name) VALUES (?, ?)",
                    (category, tag)
                )
                tid = conn.execute(
                    "SELECT trait_id FROM traits WHERE category = ? AND name = ?",
                    (category, tag)
                ).fetchone()["trait_id"]
                conn.execute(
                    "INSERT OR IGNORE INTO character_traits (char_id, trait_id) VALUES (?, ?)",
                    (char_id, tid)
                )

        conn.commit()
        row = conn.execute("SELECT * FROM characters WHERE char_id = ?", (char_id,)).fetchone()
        traits = fetch_tier2_traits(conn, [row["char_id"]])
        return web.json_response({"ok": True, "character": assemble_char(row, traits.get(row["char_id"], {}))})

    except Exception as e:
        print(f"[WaifuDB] /char_update error: {e}")
        return web.json_response({"error": str(e)}, status=500)
    finally:
        if conn:
            conn.close()


# ---------------------------------------------------------------------------
# Thumbnail serving
# ---------------------------------------------------------------------------

@lru_cache(maxsize=128)
def _resized_picture(path, mtime_ns, byte_size, size):
    """Bounded cache of encoded previews; original picture stays on disk."""
    from PIL import Image, ImageOps
    from io import BytesIO
    bounds = {"small": (240, 102), "preview": (1440, 608)}[size]
    with Image.open(path) as original:
        picture = ImageOps.exif_transpose(original)
        picture.thumbnail(bounds, Image.Resampling.LANCZOS)
        if picture.mode not in ("RGB", "RGBA"):
            picture = picture.convert("RGBA" if "A" in picture.getbands() else "RGB")
        output = BytesIO()
        picture.save(output, format="WEBP", quality=85)
        return output.getvalue()


def resolve_relocated_picture(path, directory="/mnt/KIOXIA_2To/Ressources/THUMBS"):
    """Resolve legacy filename spelling, preserving literal filenames on disk."""
    basename = os.path.basename(path)
    exact = os.path.join(directory, basename)
    if os.path.isfile(exact):
        return exact
    def normalized(name):
        return name.replace("\\(", "(").replace("\\)", ")").replace("_", " ")
    try:
        with os.scandir(directory) as entries:
            files = [entry.name for entry in entries if entry.is_file()]
    except OSError:
        return None
    equivalent = [name for name in files if normalized(name) == normalized(basename)]
    if len(equivalent) == 1:
        return os.path.join(directory, equivalent[0])
    # A numeric prefix is usable only if it identifies exactly one image.
    prefix = basename.split("-", 1)[0]
    if prefix.isdigit() and "-" in basename:
        candidates = [name for name in files if name.startswith(prefix + "-") and os.path.splitext(name)[1].lower() in (".webp", ".png", ".jpg", ".jpeg", ".gif")]
        if len(candidates) == 1:
            return os.path.join(directory, candidates[0])
    return None


@PromptServer.instance.routes.get("/custom_character_search/thumbnail/{char_id}")
@threaded_route
async def get_thumbnail(request):
    """
    Serve the thumbnail image for a character by char_id.
    Returns the image bytes with the appropriate Content-Type, or 404 if not found.
    """
    size = request.query.get("size", "original")
    if size not in ("original", "small", "preview"):
        return web.Response(status=400, text="Invalid picture size")
    char_id_str = request.match_info.get("char_id", "")
    try:
        char_id = int(char_id_str)
    except ValueError:
        return web.Response(status=400, text="Invalid char_id")

    conn = None
    try:
        conn = get_db_connection()
        row = conn.execute(
            "SELECT thumbnail_path FROM characters WHERE char_id = ?", (char_id,)
        ).fetchone()
    except Exception as e:
        return web.Response(status=500, text=str(e))
    finally:
        if conn:
            conn.close()

    if not row or not row["thumbnail_path"]:
        return web.Response(status=404, text="No thumbnail")

    path = row["thumbnail_path"]
    if not os.path.isabs(path):
        path = os.path.join(os.path.dirname(DB_PATH), path)
    if not os.path.isfile(path):
        # Relocated pictures: preserve the database filename literally on Linux.
        relocated = resolve_relocated_picture(path)
        if relocated:
            path = relocated
        else:
            return web.Response(status=404, text="File not found on disk")

    ext = os.path.splitext(path)[1].lower()
    content_type = {
        ".jpg":  "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png":  "image/png",
        ".webp": "image/webp",
        ".gif":  "image/gif",
    }.get(ext, "application/octet-stream")

    try:
        def read_image():
            with open(path, "rb") as f:
                return f.read()
        if size == "original":
            data = await asyncio.to_thread(read_image)
        else:
            stat = os.stat(path)
            data = await asyncio.to_thread(_resized_picture, path, stat.st_mtime_ns, stat.st_size, size)
            content_type = "image/webp"
        return web.Response(
            body=data,
            content_type=content_type,
            headers={"Cache-Control": "public, max-age=3600"},
        )
    except Exception as e:
        return web.Response(status=500, text=str(e))


@PromptServer.instance.routes.get("/custom_character_search/auto_25")
@threaded_route
async def auto_25(request):
    if not schema_ready():
        return web.json_response(
            {"error": "Database schema is outdated. Please re-run csv2sqlite.py."},
            status=503
        )

    """
    Return up to 25 random characters from the database as fully-assembled
    character dicts (same shape as char_search / series_chars), so the
    frontend can run buildTagsForChar on each one.

    Query params (all optional):
        series – restrict the random pool to a single series (exact match
                 against series.name). Omitted/blank means "any series".
    """
    series = request.query.get("series", "").strip()

    conn = None
    try:
        conn = get_db_connection()

        if series:
            char_rows = conn.execute("""
                SELECT c.*
                FROM characters c
                JOIN character_series cs ON c.char_id = cs.char_id
                JOIN series s ON cs.series_id = s.series_id
                WHERE s.name = ?
                ORDER BY RANDOM()
                LIMIT 25
            """, (series,)).fetchall()
        else:
            char_rows = conn.execute("""
                SELECT c.*
                FROM characters c
                WHERE c.rowid IN (
                    SELECT rowid FROM characters
                    ORDER BY RANDOM()
                    LIMIT 25
                )
            """).fetchall()

        if not char_rows:
            return web.json_response({"characters": []})

        traits = fetch_tier2_traits(conn, [r["char_id"] for r in char_rows])
        characters = [
            assemble_char(c, traits.get(c["char_id"], {})) for c in char_rows
        ]

        return web.json_response({"characters": characters})

    except Exception as e:
        print(f"[WaifuDB] /auto_25 error: {e}")
        return web.json_response({"error": str(e)}, status=500)
    finally:
        if conn:
            conn.close()


# ---------------------------------------------------------------------------
# Node definition
# ---------------------------------------------------------------------------

class WaifuDBNode(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="Magik.WaifuDB",
            display_name="WaifuDB",
            category="Magik/Tool",
            inputs=[
                io.String.Input("character_tags", default="", multiline=True),
                io.String.Input("character_nl", default="", multiline=True),
                io.Combo.Input("export_format", options=["tags", "nl", "both"], default="tags"),
                io.Int.Input("index_override", display_name="Index override", optional=True,
                             force_input=True, min=0,
                             tooltip="Zero-based character position ordered by char_id. When connected, replaces character_tags with the full database prompt."),
            ],
            outputs=[
                io.String.Output("prompt_tags", display_name="prompt_tags"),
                io.String.Output("face_prompt", display_name="Face prompt"),
            ],
        )

    @classmethod
    def execute(cls, character_tags, index_override=None, character_nl="", export_format="tags"):
        if export_format not in ("tags", "nl", "both"):
            raise ValueError("Invalid export format")
        identity = None
        if index_override is not None:
            character = get_character_by_index(index_override)
            character_tags = build_character_prompt(character)
            character_nl = " ".join(str(character.get(field) or "") for field in ("nl_girl_description", "nl_clothing")).strip()
            identity = build_character_prompt({"danbooru_tag": character["danbooru_tag"]})
        prompt = character_tags if export_format == "tags" else character_nl if export_format == "nl" else "\n".join(part for part in (character_tags, character_nl) if part)
        return io.NodeOutput(prompt, build_face_prompt(character_tags, [identity]) if identity else build_face_prompt(character_tags))
