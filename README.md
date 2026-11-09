# WaifuDB bug-fix update

Copy `__init__.py` and `magik_waifudb.py` into the existing custom-node directory, and copy `js/search_panel.js` and `js/search_panel.css` into its `js` directory. Keep your existing `character_db_modular.sqlite` and thumbnails. Restart ComfyUI and reload the browser page.

Use only the canonical `search_panel.js`. If the old `search_panel(1).js` is installed too, remove it or replace it with the compatibility loader supplied separately. The loader imports the canonical module and avoids registering the extension twice.

## Fixes

- Thumbnail serving imports asyncio correctly and reads image files in a worker.
- Character Search favorites use database IDs, including when browsing a series. Previously miskeyed local favorites are normalized from their stored character records when loaded.
- Prompt preview, count, Copy, Undo and a visible Close control are wired for both selection panels. Preview updates after selection, removal, clearing, editing and category/override changes.
- Out-of-order series, character and trait responses cannot replace newer results. Closing panels invalidates pending selection requests and immediately disposes dropdown listeners.
- Trait search requests 200 results and displays a truncation notice at that limit.
- Hair-color choices include both database slots.
- Tag normalization removes duplicates after converting underscores to spaces; missing identity tags do not crash construction.
- Saves validate body shape, IDs, field names and values. Partial clothing updates are rejected instead of silently deleting the other clothing field. Clothing tags are deduplicated before insertion.
- Save responses return the canonical database record; the frontend adopts that record and invalidates its filter cache.
- SQLite routes run in workers using request snapshots. Missing databases are not accidentally created. Schema checks cover referenced columns and the required FTS5 trigram table, and refresh after database changes.
- Tag widget callbacks are notified; Auto-25 reports a missing widget and ignores successful responses after its panel closes.
- Dropdowns and thumbnail previews have explicit cleanup; images load lazily. Narrow-screen layout and keyboard-focus styling are included.
- Both current and legacy node IDs are recognized by the canonical frontend.

## Validation

Python and JavaScript syntax checks passed. Tests using a temporary SQLite database passed for thumbnail responses, FTS search, trait filtering, edit validation and persistence, schema recovery, and random selection. Isolated JavaScript tag tests passed for parentheses, overrides, normalized deduplication, secondary hair color and empty data.

A browser interaction test was prepared but could not run because the environment has no browser executable. The real database and running ComfyUI were not supplied, so live integration and visual behavior still need checking there.

## Database limitations retained

The existing schema stores all clothing in one category. `common_outfits` is therefore still the first three clothing tags in alphabetical order and `clothing_pieces` is the remainder; the two labels do not represent independent database categories. The editor sends both together. Separating these concepts accurately requires a database migration and source-data decisions.

Favorites are browser-local snapshots. Changes made by another browser or external database editor are not automatically synchronized into those snapshots. Random selection still uses SQLite `ORDER BY RANDOM()`; large pools can be expensive, but the HTTP routes no longer block the server event loop during that work.

## Index override

The optional integer socket **Index override** replaces `character_tags` at execution when connected. It uses a **zero-based position**, ordered by `characters.char_id ASC`; it is a position, not the character ID. Index 0 selects the first character. Negative or out-of-range indexes raise a clear error. With no connection, the node keeps its normal string passthrough behavior.

The override returns one full character prompt, including identity, physical traits, clothing, accessories and other tags. Formatting follows the frontend rules (escaped parentheses, spaces instead of underscores, deduplicated tags, secondary hair color only for multicolored hair). Browser modal checkboxes and the large-breasts override do not apply; values come from the database. Adding or deleting earlier records can shift positional indexes.

## Face prompt output

The second string output **Face prompt** filters the effective prompt in both manual and Index override modes. It retains character identity, hair, eyes, facial features and expressions, ears/horns, makeup, facial hair, and recognized head accessories such as hats, crowns, hair ornaments, glasses and earrings. Body traits, clothing and non-head accessories are excluded. The full `prompt_tags` output is unchanged.

Filtering is deterministic and tag-based. Unknown tags after the identity are excluded conservatively. Manual input follows the panel's identity-first format: the first tag of each blank-line-separated character block is treated as identity unless it clearly names clothing/body details. Database overrides use the actual identity tag. Arbitrary prose and unusual accessory names may need additional vocabulary; this is not a semantic language model.

Hair-length conflict rule: when one character's assembled tags contain both `long hair` and `short hair`, `short hair` is discarded. This applies to database-index prompts and all browser selection/Auto-25 prompts, independently per character. The database itself is unchanged.

## Full-picture previews

The supplied updated database paths use `/mnt/KIOXIA_2To/Ressources/THUMBS/00000-name-.webp`, indexed from zero in `char_id` order. Character IDs are unchanged. Names are preserved from the character-name portion of the previous filenames, including their filesystem-safe punctuation.

Landscape pictures are displayed uncropped. Small list images use server-generated WebP previews up to 240 × 102; hover previews use up to 1440 × 608 and fit the viewport. Clicking a dropdown image opens the original file. Preview encoding uses Pillow (already used by ComfyUI) and a bounded 128-entry cache keyed by source file modification time and size. Browser image caching is one hour. The source pictures and their resolution are unchanged.
