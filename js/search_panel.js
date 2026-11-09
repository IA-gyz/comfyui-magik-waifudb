import { app } from "../../scripts/app.js";

// ---------------------------------------------------------------------------
// Automated Stylsheet Pipeline Injection
// ---------------------------------------------------------------------------
function loadCSS() {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = new URL("./search_panel.css", import.meta.url).href;
    document.head.appendChild(link);
}
loadCSS();

// ---------------------------------------------------------------------------
// Recent series — persists across reloads via localStorage
// ---------------------------------------------------------------------------
const RECENT_MAX = 8;
const RECENT_KEY = "waifudb_recent_series";

function loadRecentSeries() {
    try {
        const raw = localStorage.getItem(RECENT_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter(v => typeof v === "string").slice(0, RECENT_MAX) : [];
    } catch { return []; }
}

function saveRecentSeries(arr) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(arr)); } catch {}
}

const recentSeries = loadRecentSeries();

function pushRecentSeries(name) {
    const idx = recentSeries.indexOf(name);
    if (idx !== -1) recentSeries.splice(idx, 1);
    recentSeries.unshift(name);
    if (recentSeries.length > RECENT_MAX) recentSeries.pop();
    saveRecentSeries(recentSeries);
}

// ---------------------------------------------------------------------------
// Favorites — persists across reloads via localStorage
// ---------------------------------------------------------------------------
const FAV_KEY = "waifudb_favorites";

function loadFavorites() {
    try {
        const raw = localStorage.getItem(FAV_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return Object.fromEntries(Object.values(parsed)
            .filter(c => c && c.char_id != null && typeof c.original_input === "string")
            .map(c => [String(c.char_id), { ...c, char_id: String(c.char_id) }]));
    } catch { return {}; }
}

function saveFavorites(favs) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch {}
}

const favorites = loadFavorites(); 

function isFavorite(charId) { return !!favorites[String(charId)]; }

function toggleFavorite(charId, charData) {
    const id = String(charId);
    if (favorites[id]) {
        delete favorites[id];
    } else {
        favorites[id] = charData;
    }
    saveFavorites(favorites);
}

function getFavoritesList() {
    return Object.values(favorites).sort((a, b) =>
        (a.original_input || "").localeCompare(b.original_input || "")
    );
}

// ---------------------------------------------------------------------------
// Super Favorites (My Waifus) — persists across reloads via localStorage
// ---------------------------------------------------------------------------
const SUPER_FAV_KEY = "waifudb_super_favorites";

function loadSuperFavorites() {
    try {
        const raw = localStorage.getItem(SUPER_FAV_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return Object.fromEntries(Object.values(parsed)
            .filter(c => c && c.char_id != null && typeof c.original_input === "string")
            .map(c => [String(c.char_id), { ...c, char_id: String(c.char_id) }]));
    } catch { return {}; }
}

function saveSuperFavorites(favs) {
    try { localStorage.setItem(SUPER_FAV_KEY, JSON.stringify(favs)); } catch {}
}

const superFavorites = loadSuperFavorites(); 

function isSuperFavorite(charId) { return !!superFavorites[String(charId)]; }

function toggleSuperFavorite(charId, charData) {
    const id = String(charId);
    if (superFavorites[id]) {
        delete superFavorites[id];
    } else {
        superFavorites[id] = charData;
    }
    saveSuperFavorites(superFavorites);
    // Dispatch global event so the My Waifus tile grid can re-render immediately
    document.dispatchEvent(new CustomEvent("waifudb_super_favorites_changed"));
}

function getSuperFavoritesList() {
    return Object.values(superFavorites).sort((a, b) =>
        (a.original_input || "").localeCompare(b.original_input || "")
    );
}

function setLoading(modal, visible, message = "Loading…") {
    const el = modal.querySelector("#magikLoadingMsg");
    if (!el) return;
    el.textContent = message;
    el.style.display = visible ? "block" : "none";
}

function showError(modal, message) {
    const el = modal.querySelector("#magikErrorMsg");
    if (!el) return;
    el.textContent = message ? "⚠ " + message : "";
    el.style.display = message ? "block" : "none";
}

// ---------------------------------------------------------------------------
// Dropdown panel positioning (shared by createSearchableSelect / createCharSelect)
// ---------------------------------------------------------------------------
// Dropdown panels are position:fixed (viewport-relative) rather than
// absolutely anchored inside .waifudb-dropdown-root, because an
// absolutely-positioned panel gets clipped at the modal's own border once
// the modal sets `overflow-y: auto` — short modals in particular leave the
// panel with almost no visible height. We compute the panel's screen
// position by hand instead, and flip it above the trigger when there isn't
// room below.
function attachDropdownPositioning(trigger, panel) {
    function positionPanel() {
        const rect = trigger.getBoundingClientRect();
        const margin = 4;
        const spaceBelow = window.innerHeight - rect.bottom - margin;
        const spaceAbove = rect.top - margin;
        const naturalHeight = panel.scrollHeight || 260;

        panel.style.left = `${rect.left}px`;
        panel.style.width = `${rect.width}px`;

        if (spaceBelow < naturalHeight && spaceAbove > spaceBelow) {
            // Not enough room below, and more room above: flip upward.
            panel.style.top = "";
            panel.style.bottom = `${window.innerHeight - rect.top + margin}px`;
            panel.style.maxHeight = `${Math.max(120, spaceAbove)}px`;
        } else {
            panel.style.bottom = "";
            panel.style.top = `${rect.bottom + margin}px`;
            panel.style.maxHeight = `${Math.max(120, spaceBelow)}px`;
        }
    }
    function startTracking() {
        positionPanel();
        // Capture phase so scrolling any ancestor (e.g. the modal body)
        // keeps the panel glued to the trigger — scroll events don't bubble,
        // but a capture listener on window still sees them.
        window.addEventListener("scroll", positionPanel, true);
        window.addEventListener("resize", positionPanel);
    }
    function stopTracking() {
        window.removeEventListener("scroll", positionPanel, true);
        window.removeEventListener("resize", positionPanel);
    }
    return { positionPanel, startTracking, stopTracking };
}

// ---------------------------------------------------------------------------
// createSearchableSelect
// ---------------------------------------------------------------------------
function createSearchableSelect({ placeholder = "Select…", onSelect } = {}) {
    let allItems = [];
    let selectedValue = "";
    let isOpen = false;
    let sortMode = "alpha"; 

    const root = document.createElement("div");
    root.classList.add("waifudb-dropdown-root");

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.classList.add("waifudb-dropdown-trigger");
    trigger.innerHTML = `<span class="magik-trigger-label">${placeholder}</span><span>▾</span>`;
    root.appendChild(trigger);

    const panel = document.createElement("div");
    panel.classList.add("waifudb-dropdown-panel");
    root.appendChild(panel);

    const sortBar = document.createElement("div");
    sortBar.classList.add("waifudb-dropdown-sortbar");
    panel.appendChild(sortBar);

    function makeSortBtn(label, mode) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.classList.add("waifudb-dropdown-sort-btn");
        if (sortMode === mode) btn.classList.add("waifudb-active");
        
        btn.addEventListener("mousedown", e => {
            e.preventDefault();
            if (sortMode === mode) return;
            sortMode = mode;
            sortBar.querySelectorAll(".waifudb-dropdown-sort-btn").forEach(b => {
                b.classList.toggle("waifudb-active", b === btn);
            });
            renderList(searchInput.value);
        });
        return btn;
    }
    sortBar.appendChild(makeSortBtn("A – Z", "alpha"));
    sortBar.appendChild(makeSortBtn("Most characters", "count"));

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Filter…";
    searchInput.classList.add("waifudb-dropdown-search");
    panel.appendChild(searchInput);

    const list = document.createElement("div");
    list.classList.add("waifudb-dropdown-list");
    panel.appendChild(list);

    function renderList(query = "") {
        list.innerHTML = "";
        const q = query.toLowerCase();
        let filtered = q
            ? allItems.filter(it => it.label.toLowerCase().includes(q))
            : allItems.slice();

        const hasCount = allItems.length > 0 && allItems[0].count != null;
        if (hasCount && sortMode === "count") {
            filtered = filtered.slice().sort((a, b) => (b.count || 0) - (a.count || 0));
        }

        if (selectedValue && !q) {
            const clearRow = document.createElement("div");
            clearRow.textContent = "✕ Clear selection";
            clearRow.classList.add("waifudb-dropdown-clear-row");
            clearRow.addEventListener("mousedown", e => { e.preventDefault(); select("", ""); });
            list.appendChild(clearRow);
        }

        if (filtered.length === 0) {
            const empty = document.createElement("div");
            empty.textContent = "No results";
            empty.classList.add("waifudb-dropdown-empty-row");
            list.appendChild(empty);
            return;
        }
        filtered.forEach(item => {
            const row = document.createElement("div");
            row.classList.add("waifudb-dropdown-item-row");
            if (item.value === selectedValue) row.classList.add("waifudb-selected");

            const nameSpan = document.createElement("span");
            nameSpan.textContent = item.label;
            nameSpan.classList.add("waifudb-dropdown-item-name");
            row.appendChild(nameSpan);

            if (item.count != null) {
                const badge = document.createElement("span");
                badge.textContent = item.count;
                badge.classList.add("waifudb-dropdown-badge");
                row.appendChild(badge);
            }
            row.addEventListener("mousedown", e => {
                e.preventDefault();
                select(item.value, item.label);
            });
            list.appendChild(row);
        });
    }

    const dropdownPositioning = attachDropdownPositioning(trigger, panel);

    function open() {
        panel.classList.add("waifudb-open");
        isOpen = true;
        searchInput.value = "";
        const hasCount = allItems.length > 0 && allItems[0].count != null;
        sortBar.style.display = hasCount ? "flex" : "none";
        renderList();
        dropdownPositioning.startTracking();
        searchInput.focus();
    }

    function close() {
        panel.classList.remove("waifudb-open");
        isOpen = false;
        dropdownPositioning.stopTracking();
    }

    function select(value, label) {
        selectedValue = value;
        const lbl = trigger.querySelector(".magik-trigger-label");
        lbl.textContent = label || placeholder;
        lbl.style.color = label ? "#eee" : "#aaa";
        close();
        onSelect && onSelect(value, label);
    }

    trigger.addEventListener("click", e => { e.stopPropagation(); isOpen ? close() : open(); });
    searchInput.addEventListener("input", () => renderList(searchInput.value));
    function onDocClick(e) {
        if (!root.isConnected) {
            document.removeEventListener("mousedown", onDocClick);
            if (isOpen) close();
            return;
        }
        if (!root.contains(e.target)) close();
    }
    document.addEventListener("mousedown", onDocClick);

    root.setItems = function(items) {
        allItems = items.map(i =>
            typeof i === "string"
                ? { value: i, label: i }
                : { value: i.value ?? i.name, label: i.label ?? i.name, count: i.count, thumbnail: i.thumbnail }
        );
        select("", "");
        const lbl = trigger.querySelector(".magik-trigger-label");
        lbl.textContent = placeholder;
        lbl.style.color = "#aaa";
    };
    root.dispose = () => { close(); document.removeEventListener("mousedown", onDocClick); };
    root.getValue = () => selectedValue;
    root.reset    = () => select("", "");
    root.selectByValue = function(value) {
        const item = allItems.find(i => i.value === value);
        if (item) select(item.value, item.label);
    };
    Object.defineProperty(root, "isOpen", { get: () => isOpen });
    return root;
}

// ---------------------------------------------------------------------------
// Flyout Preview System Initialization
// ---------------------------------------------------------------------------
const hoverFlyout = document.createElement("img");
hoverFlyout.classList.add("waifudb-flyout");
if (document.body) {
    document.body.appendChild(hoverFlyout);
} else {
    document.addEventListener("DOMContentLoaded", () => document.body.appendChild(hoverFlyout));
}

// ---------------------------------------------------------------------------
// createCharSelect
// ---------------------------------------------------------------------------
function createCharSelect({ onSelect } = {}) {
    const DEBOUNCE_MS   = 220;
    const MIN_QUERY_LEN = 3;
    const SEARCH_LIMIT  = 50;

    let mode          = "search";
    let staticItems   = [];   
    let selectedValue = "";
    let isOpen        = false;
    let debounceTimer = null;
    let activeRequest = 0;
    let lastRenderedItems = [];
    let lastRenderedHl    = "";

    const root = document.createElement("div");
    root.classList.add("waifudb-dropdown-root");

    const tabBar = document.createElement("div");
    tabBar.classList.add("waifudb-tab-bar");
    root.appendChild(tabBar);

    function makeTab(label, targetMode) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.dataset.tabMode = targetMode;
        btn.classList.add("waifudb-tab");
        
        btn.addEventListener("mousedown", e => {
            e.preventDefault();
            clearTimeout(debounceTimer);
            activeRequest++;
            if (mode === targetMode && isOpen) return;
            if (targetMode === "favorites") {
                mode = "favorites";
                staticItems = getFavoritesList().map(c => ({
                    value: c.char_id, label: c.original_input, data: c,
                }));
            } else {
                mode = "search";
                staticItems = [];
            }
            updateTabStyles();
            if (!isOpen) open(); else { searchInput.value = ""; renderItems(currentItems(), ""); }
        });
        return btn;
    }

    const tabAll  = makeTab("All", "search");
    const tabFavs = makeTab("★ Favorites", "favorites");
    tabBar.appendChild(tabAll);
    tabBar.appendChild(tabFavs);

    function updateTabStyles() {
        [tabAll, tabFavs].forEach(t => {
            const active = t.dataset.tabMode === mode
                || (t.dataset.tabMode === "search" && mode === "series");
            t.classList.toggle("waifudb-active", active);
        });
    }
    updateTabStyles();

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.classList.add("waifudb-dropdown-trigger", "waifudb-dropdown-trigger-flat-bottom");
    trigger.innerHTML = `<span class="magik-clabel">Select Character…</span><span>▾</span>`;
    root.appendChild(trigger);

    const panel = document.createElement("div");
    panel.classList.add("waifudb-dropdown-panel");
    root.appendChild(panel);

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.classList.add("waifudb-dropdown-search");
    panel.appendChild(searchInput);

    const statusLine = document.createElement("div");
    statusLine.classList.add("waifudb-dropdown-status");
    statusLine.style.display = "none";
    panel.appendChild(statusLine);

    const list = document.createElement("div");
    list.classList.add("waifudb-dropdown-list");
    panel.appendChild(list);

    function renderItems(items, hl = "") {
        lastRenderedItems = items;
        lastRenderedHl    = hl;
        list.innerHTML = "";
        if (!items.length) {
            const el = document.createElement("div");
            el.textContent = mode === "favorites" ? "No favorites yet — click ★ on any character" : "No results";
            el.classList.add("waifudb-dropdown-empty-row");
            list.appendChild(el);
            return;
        }
        const hlLow = hl.toLowerCase();
        items.forEach(item => {
            const isFav = isFavorite(item.value);
            const isSuper = isSuperFavorite(item.value);
            const row = document.createElement("div");
            row.classList.add("waifudb-dropdown-item-row", "waifudb-dropdown-item-row-char");
            if (item.value === selectedValue) row.classList.add("waifudb-selected");

            const thumb = document.createElement("img");
            thumb.classList.add("waifudb-thumb");
            thumb.alt = "";
            if (item.data && item.data.char_id) {
                const thumbUrl = `/custom_character_search/thumbnail/${item.data.char_id}`;

                thumb.loading = "lazy";
                thumb.src = thumbUrl + "?size=small";
                thumb.title = "Click to open full image";
                thumb.onerror = () => { thumb.style.display = "none"; };
                
                thumb.addEventListener("mouseenter", e => {
                    hoverFlyout.style.display = "none";
                    hoverFlyout.onload = () => {
                        const scale = Math.min(1, (window.innerWidth - 30) / hoverFlyout.naturalWidth, (window.innerHeight - 30) / hoverFlyout.naturalHeight);
                        const targetWidth = hoverFlyout.naturalWidth * scale;
                        const targetHeight = hoverFlyout.naturalHeight * scale;

                        hoverFlyout.style.width = targetWidth + "px";
                        hoverFlyout.style.height = targetHeight + "px";

                        const panelRect = panel.getBoundingClientRect();
                        let leftPos = panelRect.left - targetWidth - 15;

                        if (leftPos < 10) {
                            leftPos = panelRect.right + 15;
                        }

                        let topPos = e.clientY - (targetHeight / 2);
                        if (topPos < 10) topPos = 10;
                        if (topPos + targetHeight > window.innerHeight) {
                            topPos = window.innerHeight - targetHeight - 10;
                        }

                        leftPos = Math.max(10, Math.min(leftPos, window.innerWidth - targetWidth - 10));
                        hoverFlyout.style.left = leftPos + "px";
                        hoverFlyout.style.top = topPos + "px";
                        if (!isOpen || !thumb.matches(":hover")) return;
                        hoverFlyout.style.display = "block";
                    };
                    hoverFlyout.src = thumbUrl + "?size=preview";
                });

                thumb.addEventListener("mouseleave", () => {
                    hoverFlyout.style.display = "none";
                    hoverFlyout.src = "";
                });
                
                thumb.addEventListener("mousedown", e => {
                    e.preventDefault();
                    e.stopPropagation(); 
                    window.open(thumbUrl, "_blank");
                });
            } else {
                thumb.style.display = "none";
            }
            row.appendChild(thumb);

            const nameSpan = document.createElement("span");
            nameSpan.classList.add("waifudb-dropdown-item-name");
            if (hlLow && item.label.toLowerCase().includes(hlLow)) {
                const idx = item.label.toLowerCase().indexOf(hlLow);
                const mark = document.createElement("mark");
                mark.textContent = item.label.slice(idx, idx + hlLow.length);
                nameSpan.append(
                    document.createTextNode(item.label.slice(0, idx)),
                    mark,
                    document.createTextNode(item.label.slice(idx + hlLow.length))
                );
            } else {
                nameSpan.textContent = item.label;
            }
            row.appendChild(nameSpan);

            if (mode !== "favorites") {
                // Yellow Star (Standard Favorite)
                const star = document.createElement("span");
                star.textContent = isFav ? "★" : "☆";
                star.title = isFav ? "Remove from favorites" : "Add to favorites";
                star.classList.add("waifudb-star-icon");
                if (isFav) star.classList.add("waifudb-is-favorite");
                
                star.addEventListener("mouseleave", () => {
                    star.classList.toggle("waifudb-is-favorite", isFavorite(item.value));
                });
                star.addEventListener("mousedown", e => {
                    e.preventDefault();
                    e.stopPropagation(); 
                    toggleFavorite(item.value, item.data);
                    const nowFav = isFavorite(item.value);
                    star.textContent = nowFav ? "★" : "☆";
                    star.classList.toggle("waifudb-is-favorite", nowFav);
                    updateFavTab();
                    renderItems(lastRenderedItems, lastRenderedHl);
                });
                row.appendChild(star);

                // Pink Star (Super Favorite / My Waifus)
                const superStar = document.createElement("span");
                superStar.textContent = isSuper ? "★" : "☆";
                superStar.title = isSuper ? "Remove from My Waifus" : "Add to My Waifus";
                superStar.classList.add("waifudb-star-icon", "waifudb-super-star-icon");
                if (isSuper) superStar.classList.add("waifudb-is-super-favorite");

                superStar.addEventListener("mouseleave", () => {
                    superStar.classList.toggle("waifudb-is-super-favorite", isSuperFavorite(item.value));
                });
                superStar.addEventListener("mousedown", e => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleSuperFavorite(item.value, item.data);
                    const nowSuper = isSuperFavorite(item.value);
                    superStar.textContent = nowSuper ? "★" : "☆";
                    superStar.classList.toggle("waifudb-is-super-favorite", nowSuper);
                    renderItems(lastRenderedItems, lastRenderedHl);
                });
                row.appendChild(superStar);
            }

            if (mode === "favorites") {
                const removeBtn = document.createElement("span");
                removeBtn.textContent = "✕";
                removeBtn.title = "Remove from favorites";
                removeBtn.classList.add("waifudb-remove-fav-btn");
                
                removeBtn.addEventListener("mousedown", e => {
                    e.preventDefault();
                    e.stopPropagation();
                    const id = String(item.value);
                    delete favorites[id];
                    saveFavorites(favorites);
                    updateFavTab();
                    renderItems(
                        getFavoritesList().map(c => ({ value: c.char_id, label: c.original_input, data: c })),
                        lastRenderedHl
                    );
                });
                row.appendChild(removeBtn);
            }

            row.addEventListener("mousedown", e => { e.preventDefault(); select(item.value, item.label, item.data); });
            list.appendChild(row);
        });
    }

    function updateFavTab() {
        const n = Object.keys(favorites).length;
        tabFavs.textContent = n > 0 ? `★ Favorites (${n})` : "★ Favorites";
    }
    updateFavTab();

    function setStatus(text) {
        statusLine.textContent = text;
        statusLine.style.display = text ? "block" : "none";
    }

    function currentItems() {
        if (mode === "favorites")
            return getFavoritesList().map(c => ({ value: c.char_id, label: c.original_input, data: c }));
        if (mode === "series") return staticItems;
        return [];
    }

    const dropdownPositioning = attachDropdownPositioning(trigger, panel);

    function open() {
        panel.classList.add("waifudb-open");
        isOpen = true;
        keyboardFocusIdx = -1;
        searchInput.value = "";
        updateTabStyles();
        if (mode === "favorites") {
            searchInput.placeholder = "Filter favorites…";
            setStatus("");
            renderItems(currentItems(), "");
        } else if (mode === "series") {
            searchInput.placeholder = "Filter…";
            setStatus("");
            renderItems(staticItems, "");
        } else {
            searchInput.placeholder = "Search all characters…";
            setStatus(`Type at least ${MIN_QUERY_LEN} characters to search…`);
            list.innerHTML = "";
        }
        dropdownPositioning.startTracking();
        searchInput.focus();
    }

    function close() {
        panel.classList.remove("waifudb-open");
        isOpen = false;
        clearTimeout(debounceTimer);
        activeRequest++;
        hoverFlyout.style.display = "none";
        dropdownPositioning.stopTracking();
    }

    function select(value, label, data) {
        selectedValue = value;
        const lbl = trigger.querySelector(".magik-clabel");
        lbl.textContent = label || "Select Character…";
        lbl.style.color = label ? "#eee" : "#aaa";
        close();
        onSelect && onSelect(value, label, data);
    }

    let keyboardFocusIdx = -1;
    function setKeyboardFocus(idx) {
        const rows = list.querySelectorAll(".waifudb-dropdown-item-row");
        rows.forEach((r, i) => r.classList.toggle("waifudb-keyboard-focus", i === idx));
        keyboardFocusIdx = idx;
        if (idx >= 0 && rows[idx]) rows[idx].scrollIntoView({ block: "nearest" });
    }

    searchInput.addEventListener("keydown", e => {
        const rows = list.querySelectorAll(".waifudb-dropdown-item-row");
        if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!isOpen) open();
            setKeyboardFocus(Math.min(keyboardFocusIdx + 1, rows.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (!isOpen) open();
            setKeyboardFocus(Math.max(keyboardFocusIdx - 1, 0));
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (keyboardFocusIdx >= 0 && rows[keyboardFocusIdx]) {
                rows[keyboardFocusIdx].dispatchEvent(new Event("mousedown", { bubbles: true }));
            } else if (isOpen) {
                close();
            }
        } else if (e.key === "Escape") {
            if (isOpen) close();
        }
    });

    searchInput.addEventListener("input", () => {
        const q = searchInput.value.trim();
        const inputRequest = ++activeRequest;

        if (mode === "favorites" || mode === "series") {
            const items = currentItems();
            const ql = q.toLowerCase();
            renderItems(
                ql ? items.filter(i => i.label.toLowerCase().includes(ql)) : items,
                q
            );
            return;
        }

        clearTimeout(debounceTimer);
        if (q.length < MIN_QUERY_LEN) {
            setStatus(`Type at least ${MIN_QUERY_LEN} characters to search…`);
            list.innerHTML = "";
            return;
        }
        setStatus("Searching…");
        debounceTimer = setTimeout(async () => {
            const reqId = inputRequest;
            try {
                const res = await fetch(
                    `/custom_character_search/char_search?q=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`
                );
                if (reqId !== activeRequest) return;
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body.error || `Server returned ${res.status}`);
                }
                const data = await res.json();
                if (reqId !== activeRequest) return;
                const items = data.map(c => ({ value: c.char_id, label: c.original_input, data: c }));
                setStatus(items.length === SEARCH_LIMIT
                    ? `Showing top ${SEARCH_LIMIT} results`
                    : `${items.length} result${items.length !== 1 ? "s" : ""}`);
                renderItems(items, q);
            } catch (err) {
                if (reqId !== activeRequest) return;
                setStatus("Error: " + err.message);
                list.innerHTML = "";
            }
        }, DEBOUNCE_MS);
    });

    trigger.addEventListener("click", e => { e.stopPropagation(); isOpen ? close() : open(); });
    function onDocClick(e) {
        if (!root.isConnected) {
            document.removeEventListener("mousedown", onDocClick);
            if (isOpen) close();
            return;
        }
        if (!root.contains(e.target)) close();
    }
    document.addEventListener("mousedown", onDocClick);

    root.setSeriesItems = function(chars) {
        mode = "series";
        staticItems = chars.map((c, i) => ({ value: String(c.char_id), label: c.original_input || `character_${i}`, data: c }));
        _reset();
        updateTabStyles();
    };
    root.setSearchMode = function() {
        if (mode !== "favorites") mode = "search";
        staticItems = [];
        _reset();
        updateTabStyles();
    };
    function _reset() {
        selectedValue = "";
        clearTimeout(debounceTimer);
        activeRequest++;
        const lbl = trigger.querySelector(".magik-clabel");
        lbl.textContent = "Select Character…";
        lbl.style.color = "#aaa";
        if (isOpen) open();
    }
    root.dispose = () => { close(); document.removeEventListener("mousedown", onDocClick); };
    root.getValue = () => selectedValue;
    Object.defineProperty(root, "isOpen", { get: () => isOpen });
    return root;
}

// ---------------------------------------------------------------------------
// Shared tag-writing logic
// ---------------------------------------------------------------------------
const SMALL_BREAST_TAGS = new Set([
    "medium_breasts", "small_breasts", "flat_chest",
    "medium breasts",  "small breasts",  "flat chest",
]);

function escapeParens(tag) {
    return tag.replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildTagsForChar(charData, modal, enforceLarge) {
    const allCharText = [
        charData.hairstyle_1, charData.hairstyle_2,
        charData.hairstyle_3, charData.hairstyle_4,
        charData.others,
    ].join(" ").toLowerCase();
    const hasMulticoloredHair = allCharText.includes("multicolored hair")
        || allCharText.includes("multicolored_hair");

    const tagParts = [charData.danbooru_tag || ""];
    modal.querySelectorAll("#includeCheckboxes input:checked").forEach(cb => {
        const cols = cb.dataset.cols.split(",");

        if (cols.includes("hair_color_1")) {
            const val1 = (charData.hair_color_1 || "").trim();
            if (val1) tagParts.push(val1);
            if (hasMulticoloredHair) {
                const val2 = (charData.hair_color_2 || "").trim();
                if (val2) tagParts.push(val2);
            }
            return;
        }

        cols.forEach(col => {
            const val = (charData[col] || "").trim();
            if (val) tagParts.push(val);
        });
    });

    const seen = new Set();
    const tags = tagParts
        .flatMap(t => t.split(",").map(s => s.trim()))
        .map(t => (enforceLarge && SMALL_BREAST_TAGS.has(t)) ? "large_breasts" : t)
        .map(t => escapeParens(t).replace(/_/g, " "))
        .filter(t => t && !seen.has(t) && seen.add(t))
        ;
    return tags.some(t => t.toLowerCase() === "long hair")
        ? tags.filter(t => t.toLowerCase() !== "short hair")
        : tags;
}

function writeTagsToNode(node, modal, selectionList) {
    showError(modal, "");
    const chars = Array.isArray(selectionList) ? selectionList : (selectionList ? [selectionList] : []);

    if (chars.length === 0) {
        showError(modal, "Please add at least one character to the selection.");
        return false;
    }

    const enforceLarge = modal.querySelector("#magikEnforceLarge")?.checked ?? false;
    const perCharStrings = chars.map(charData => buildTagsForChar(charData, modal, enforceLarge).join(", "));
    const newText = perCharStrings.join(",\n\n");

    const widget = node.widgets.find(w => w.name === "character_tags");
    if (!widget) { showError(modal, "Could not find character_tags widget."); return false; }

    const appendMode = modal.querySelector("#magikAppend").checked;
    if (appendMode && widget.value.trim()) {
        widget.value = widget.value.trimEnd() + ",\n\n" + newText;
    } else {
        widget.value = newText;
    }
    widget.callback?.(widget.value);
    node.setDirtyCanvas(true, true);
    return true;
}

function buildPreviewText(chars, modal) {
    const enforce = modal.querySelector("#magikEnforceLarge")?.checked ?? false;
    return chars.map(c => buildTagsForChar(c, modal, enforce).join(", ")).join(",\n\n");
}
function updateLivePreview(modal, chars) {
    const el = modal.querySelector("#magikLivePreview");
    if (el) el.value = buildPreviewText(chars, modal);
}
function updateSelectionCount(modal, count) {
    const el = modal.querySelector("#magikSelectionCount");
    if (el) el.textContent = `(${count})`;
    const undo = modal.querySelector("#magikSelUndo");
    if (undo) undo.disabled = count === 0;
}
function refreshSelection(modal, chars) {
    updateLivePreview(modal, chars);
    updateSelectionCount(modal, chars.length);
}
function disposeDropdowns(modal) {
    modal.querySelectorAll(".waifudb-dropdown-root").forEach(el => el.dispose?.());
    hoverFlyout.style.display = "none";
}
function wirePreview(modal, chars) {
    modal.querySelector("#magikSelUndo")?.addEventListener("click", () => {
        const removed = chars.pop();
        if (removed) {
            const list = modal.querySelector("#magikSelectionList");
            [...list.children].find(row => row.dataset.charId === String(removed.char_id))?.remove();
        }
        refreshSelection(modal, chars);
    });
    modal.querySelectorAll("#includeCheckboxes input, #magikEnforceLarge").forEach(el =>
        el.addEventListener("change", () => refreshSelection(modal, chars)));
    refreshSelection(modal, chars);
}

// Checkbox Fragment Template
const CHECKBOX_HTML = `
    <div class="waifudb-checkbox-container">
        <div id="includeCheckboxes" class="waifudb-checkbox-grid">
            <label><input type="checkbox" data-cols="breast_size" checked> Breast Size</label>
            <label><input type="checkbox" data-cols="eye_color" checked> Eyes</label>
            <label><input type="checkbox" data-cols="hair_color_1,hair_color_2" checked> Hair Color</label>
            <label><input type="checkbox" data-cols="hairstyle_1,hairstyle_2,hairstyle_3,hairstyle_4" checked> Hairstyle</label>
            <label><input type="checkbox" data-cols="common_outfits,clothing_pieces" checked> Outfit</label>
            <label><input type="checkbox" data-cols="clothing_accessories" checked> Accessories</label>
            <label><input type="checkbox" data-cols="others" checked> Others</label>
        </div>
        <div class="waifudb-overrides-box">
            <div class="waifudb-overrides-title">Overrides</div>
            <label title="Replaces flat_chest, small_breasts and medium_breasts with large_breasts">
                <input type="checkbox" id="magikEnforceLarge" checked> Enforce large breasts
            </label>
        </div>
    </div>`;

// Selection Fragment Template
const SELECTION_HTML = `
    <div class="waifudb-selection-container">
        <div class="waifudb-selection-header">
            <div class="waifudb-selection-title">Selection <span id="magikSelectionCount">(0)</span></div>
            <button id="magikSelUndo" type="button" class="waifudb-selection-undo-btn" disabled>Undo last add</button>
            <button id="magikSelClear" type="button" class="waifudb-selection-clear-btn" title="Clear all">✕ Clear all</button>
        </div>
        <div id="magikSelectionList" class="waifudb-selection-list"></div>
        <div class="waifudb-selection-footer-text">
            Click a character above to add · ✏ to edit · ✕ to remove
        </div>
    </div>`;

// Footer Fragment Template
const FOOTER_HTML = `
    <div class="waifudb-live-preview-box"><div class="waifudb-live-preview-title">Prompt preview</div><textarea id="magikLivePreview" class="waifudb-live-preview-text" rows="4" readonly></textarea></div>
    <label class="waifudb-footer-append">
        <input type="checkbox" id="magikAppend"> Append to existing tags
    </label>
    <div id="magikLoadingMsg" class="waifudb-loading-msg" style="display:none;">Loading…</div>
    <div id="magikErrorMsg" class="waifudb-error-msg" style="display:none;"></div>
    <button id="magikCopyBtn" type="button" class="waifudb-copy-btn">Copy tags</button>
    <button id="magikSearchBtn" class="waifudb-submit-btn">Add Tags to Prompt</button>`;

// ---------------------------------------------------------------------------
// Edit character modal
// ---------------------------------------------------------------------------
async function openEditModal(charData, onSaved) {
    const overlay = document.createElement("div");
    overlay.classList.add("waifudb-overlay", "waifudb-edit-overlay");
    overlay.setAttribute("tabindex", "-1");

    const modal = document.createElement("div");
    modal.classList.add("waifudb-modal", "waifudb-modal-edit");

    const SCALAR_FIELDS = [
        { key: "breast_size",  label: "Breast Size" },
        { key: "eye_color",    label: "Eye Color" },
        { key: "hair_color_1", label: "Hair Color 1" },
        { key: "hair_color_2", label: "Hair Color 2" },
        { key: "hairstyle_1",  label: "Hairstyle 1" },
        { key: "hairstyle_2",  label: "Hairstyle 2" },
        { key: "hairstyle_3",  label: "Hairstyle 3" },
        { key: "hairstyle_4",  label: "Hairstyle 4" },
    ];
    const MULTI_FIELDS = [
        { key: "common_outfits",       label: "Common Outfits" },
        { key: "clothing_pieces",      label: "Clothing Pieces" },
        { key: "clothing_accessories", label: "Accessories" },
        { key: "others",               label: "Others" },
    ];

    function makeFieldGroup(labelText, value, id) {
        const group = document.createElement("div");
        group.classList.add("waifudb-field-group");
        const label = document.createElement("label");
        label.textContent = labelText;
        group.appendChild(label);
        const input = document.createElement("input");
        input.id = id;
        input.type = "text";
        input.value = value || "";
        group.appendChild(input);
        return group;
    }

    const h2 = document.createElement("h2");
    h2.textContent = "✏ Edit Character";
    modal.appendChild(h2);

    const meta = document.createElement("div");
    meta.classList.add("waifudb-modal-meta");
    const strong = document.createElement("strong");
    strong.textContent = charData.original_input || "";
    meta.appendChild(strong);
    meta.appendChild(document.createTextNode("  ·  "));
    const code = document.createElement("code");
    code.textContent = charData.danbooru_tag || "";
    meta.appendChild(code);
    modal.appendChild(meta);

    const scalarGrid = document.createElement("div");
    scalarGrid.classList.add("waifudb-fields-grid");
    SCALAR_FIELDS.forEach(f => {
        scalarGrid.appendChild(makeFieldGroup(f.label, charData[f.key], "edit_" + f.key));
    });
    modal.appendChild(scalarGrid);

    const multiGrid = document.createElement("div");
    multiGrid.classList.add("waifudb-fields-grid", "waifudb-fields-grid-secondary");
    MULTI_FIELDS.forEach(f => {
        multiGrid.appendChild(makeFieldGroup(f.label, charData[f.key], "edit_" + f.key));
    });
    modal.appendChild(multiGrid);

    const statusEl = document.createElement("div");
    statusEl.id = "editStatusMsg";
    statusEl.classList.add("waifudb-edit-status-msg");
    statusEl.style.display = "none";
    modal.appendChild(statusEl);

    function setEditStatus(msg, isError) {
        statusEl.textContent = msg;
        statusEl.style.color = isError ? "#f88" : "#8f8";
        statusEl.style.display = msg ? "block" : "none";
    }

    const actionsRow = document.createElement("div");
    actionsRow.classList.add("waifudb-modal-actions-row");

    const saveBtn = document.createElement("button");
    saveBtn.id = "editSaveBtn";
    saveBtn.classList.add("waifudb-save");
    saveBtn.textContent = "Save";

    const cancelBtn = document.createElement("button");
    cancelBtn.id = "editCancelBtn";
    cancelBtn.classList.add("waifudb-cancel");
    cancelBtn.textContent = "Cancel";

    actionsRow.appendChild(saveBtn);
    actionsRow.appendChild(cancelBtn);
    modal.appendChild(actionsRow);

    document.body.appendChild(overlay);
    overlay.appendChild(modal);
    overlay.focus();
    overlay.focus();

    cancelBtn.addEventListener("click", () => {
        if (overlay.parentNode) document.body.removeChild(overlay);
    });

    saveBtn.addEventListener("click", async () => {
        const updates = {};
        [...SCALAR_FIELDS, ...MULTI_FIELDS].forEach(f => {
            const input = modal.querySelector("#edit_" + f.key);
            updates[f.key] = input ? input.value.trim() : "";
        });

        saveBtn.disabled = true;
        setEditStatus("Saving…", false);
        try {
            const res = await fetch("/custom_character_search/char_update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ char_id: charData.char_id, updates }),
            });
            const result = await res.json();
            if (!res.ok || result.error) throw new Error(result.error || `Server returned ${res.status}`);

            setEditStatus("Saved!", false);
            cachedFiltersData = null;
            Object.assign(charData, result.character || updates);
            if (isFavorite(charData.char_id)) {
                favorites[String(charData.char_id)] = { ...charData };
                saveFavorites(favorites);
            }
            if (isSuperFavorite(charData.char_id)) {
                superFavorites[String(charData.char_id)] = { ...charData };
                saveSuperFavorites(superFavorites);
                document.dispatchEvent(new CustomEvent("waifudb_super_favorites_changed"));
            }
            onSaved && onSaved(charData);
            setTimeout(() => {
                if (overlay.parentNode) document.body.removeChild(overlay);
            }, 800);
        } catch (err) {
            saveBtn.disabled = false;
            setEditStatus("Error: " + err.message, true);
        }
    });

    overlay.addEventListener("mousedown", e => {
        if (e.target === overlay && overlay.parentNode) document.body.removeChild(overlay);
    });
    overlay.addEventListener("keydown", e => {
        if (e.key === "Escape" && overlay.parentNode) document.body.removeChild(overlay);
    });
}


// ---------------------------------------------------------------------------
// Panel 1 — Character search
// ---------------------------------------------------------------------------
async function openSearchPanel(node, filtersData) {
    const overlay = document.createElement("div");
    overlay.classList.add("waifudb-overlay");
    overlay.setAttribute("tabindex", "-1");

    const modal = document.createElement("div");
    modal.classList.add("waifudb-modal");

    modal.innerHTML = `
        <button type="button" class="waifudb-modal-close" aria-label="Close">✕</button><h2>🪄 Character Search</h2>
        <div class="waifudb-columns-container">
            <div class="waifudb-main-column">
                <div id="magikSeriesSlot"></div>
                <div id="magikCharSlot"></div>
                <div id="magikMyWaifusSlot" class="waifudb-my-waifus-container"></div>
            </div>
            <div id="magikRecentSeries" class="waifudb-recent-sidebar"></div>
        </div>
        ${SELECTION_HTML}
        ${CHECKBOX_HTML}
        ${FOOTER_HTML}`;

    document.body.appendChild(overlay);
    overlay.appendChild(modal);
    overlay.focus();

    const recentBox = modal.querySelector("#magikRecentSeries");

    function renderRecentSeries(onClickSeries) {
        recentBox.innerHTML = "";
        if (recentSeries.length === 0) return;
        const label = document.createElement("div");
        label.textContent = "Recent";
        label.classList.add("waifudb-recent-title");
        recentBox.appendChild(label);
        recentSeries.forEach(name => {
            const pill = document.createElement("button");
            pill.type = "button";
            pill.textContent = name;
            pill.title = name;
            pill.classList.add("waifudb-recent-pill");
            pill.addEventListener("click", () => onClickSeries(name));
            recentBox.appendChild(pill);
        });
    }

    const selectionData = [];
    const selListEl = modal.querySelector("#magikSelectionList");
    wirePreview(modal, selectionData);

    function renderSelectionRow(charData) {
        const row = document.createElement("div");
        row.dataset.charId = charData.char_id;
        row.classList.add("waifudb-selection-row");

        const name = document.createElement("span");
        name.textContent = charData.original_input;
        name.classList.add("waifudb-selection-row-name");
        row.appendChild(name);

        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.textContent = "✏";
        editBtn.title = "Edit " + charData.original_input;
        editBtn.classList.add("waifudb-selection-btn-action");
        editBtn.addEventListener("click", () => {
            const i = selectionData.findIndex(c => c.char_id === charData.char_id);
            if (i === -1) return;
            openEditModal(selectionData[i], updatedChar => {
                selectionData[i] = updatedChar;
                name.textContent = updatedChar.original_input;
                editBtn.title = "Edit " + updatedChar.original_input;
                row.dataset.charId = updatedChar.char_id;
                refreshSelection(modal, selectionData);
            });
        });
        row.appendChild(editBtn);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.textContent = "✕";
        removeBtn.title = "Remove from selection";
        removeBtn.classList.add("waifudb-selection-btn-action", "waifudb-selection-btn-remove");
        removeBtn.addEventListener("click", () => {
            const i = selectionData.findIndex(c => c.char_id === charData.char_id);
            if (i !== -1) selectionData.splice(i, 1);
            row.remove();
            refreshSelection(modal, selectionData);
        });
        row.appendChild(removeBtn);

        return row;
    }

    modal.querySelector("#magikSelClear").addEventListener("click", () => {
        selectionData.length = 0;
        selListEl.innerHTML = "";
        refreshSelection(modal, selectionData);
    });

    function addToSelection(charData) {
        if (!charData) return;
        if (selectionData.some(c => c.char_id === charData.char_id)) return;
        selectionData.push(charData);
        selListEl.appendChild(renderSelectionRow(charData));
        refreshSelection(modal, selectionData);
    }

    // Render My Waifus block
    function renderMyWaifus() {
        const slot = modal.querySelector("#magikMyWaifusSlot");
        if (!slot) return;
        slot.innerHTML = "";
        const list = getSuperFavoritesList();
        if (list.length === 0) return;

        const title = document.createElement("div");
        title.textContent = "My Waifus";
        title.classList.add("waifudb-recent-title");
        slot.appendChild(title);

        const grid = document.createElement("div");
        grid.classList.add("waifudb-my-waifus-grid");
        slot.appendChild(grid);

        list.forEach(charData => {
            const tile = document.createElement("div");
            tile.classList.add("waifudb-waifu-tile");
            tile.title = "Add " + charData.original_input;
            tile.addEventListener("click", () => addToSelection(charData));

            const removeBtn = document.createElement("span");
            removeBtn.textContent = "✕";
            removeBtn.title = "Remove from My Waifus";
            removeBtn.classList.add("waifudb-waifu-tile-remove");
            removeBtn.addEventListener("click", e => {
                e.stopPropagation();
                toggleSuperFavorite(charData.char_id, charData);
            });

            const thumbUrl = `/custom_character_search/thumbnail/${charData.char_id}`;
            const img = document.createElement("img");
            img.classList.add("waifudb-waifu-tile-img");
            img.loading = "lazy";
            img.src = thumbUrl + "?size=small";
            img.onerror = () => { img.style.display = "none"; };

            const name = document.createElement("span");
            name.classList.add("waifudb-waifu-tile-name");
            name.textContent = charData.original_input;

            tile.appendChild(removeBtn);
            tile.appendChild(img);
            tile.appendChild(name);
            grid.appendChild(tile);
        });
    }

    renderMyWaifus();
    const updateMyWaifusListener = () => renderMyWaifus();
    document.addEventListener("waifudb_super_favorites_changed", updateMyWaifusListener);

    function closePanel() {
        if (!overlay.isConnected) return;
        seriesRequest++;
        disposeDropdowns(modal);
        document.removeEventListener("waifudb_super_favorites_changed", updateMyWaifusListener);
        document.body.removeChild(overlay);
    }

    const charDropdown = createCharSelect({
        onSelect: (_v, _l, data) => { if (data) addToSelection(data); },
    });
    charDropdown.setSearchMode();
    modal.querySelector("#magikCharSlot").appendChild(charDropdown);

    let seriesRequest = 0;
    async function loadSeries(seriesName) {
        const requestId = ++seriesRequest;
        showError(modal, "");
        if (!seriesName) { setLoading(modal, false); charDropdown.setSearchMode(); return; }
        setLoading(modal, true, "Loading characters…");
        try {
            const res = await fetch(`/custom_character_search/series_chars?series=${encodeURIComponent(seriesName)}`);
            if (!res.ok) throw new Error(`Server returned ${res.status}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            if (requestId !== seriesRequest || !overlay.isConnected) return;
            charDropdown.setSeriesItems(Array.isArray(data) ? data : []);
            setLoading(modal, false);
            pushRecentSeries(seriesName);
            renderRecentSeries(recentPillClick);
        } catch (err) {
            if (requestId !== seriesRequest || !overlay.isConnected) return;
            setLoading(modal, false);
            showError(modal, "Could not load characters: " + err.message);
            charDropdown.setSearchMode();
        }
    }

    const seriesDropdown = createSearchableSelect({
        placeholder: "Select Series… (or skip to search all)",
        onSelect: loadSeries,
    });
    modal.querySelector("#magikSeriesSlot").appendChild(seriesDropdown);
    seriesDropdown.setItems(
        (filtersData.series || []).map(s => ({ value: s.name, label: s.name, count: s.count }))
    );

    function recentPillClick(name) {
        seriesDropdown.selectByValue(name);
    }

    renderRecentSeries(recentPillClick);

    modal.querySelector("#magikSearchBtn").addEventListener("click", () => {
        if (writeTagsToNode(node, modal, selectionData)) {
            closePanel();
        }
    });

    // Copy to clipboard
    modal.querySelector("#magikCopyBtn")?.addEventListener("click", () => {
        const text = buildPreviewText(selectionData, modal);
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            const btn = modal.querySelector("#magikCopyBtn");
            btn.classList.add("waifudb-copied");
            btn.textContent = "✓ Copied!";
            setTimeout(() => {
                btn.classList.remove("waifudb-copied");
                btn.textContent = "📋 Copy";
            }, 1500);
        }).catch(() => {
            showError(modal, "Could not copy to clipboard.");
        });
    });

    // Close button
    modal.querySelector(".waifudb-modal-close")?.addEventListener("click", closePanel);

        // Focus trap
        function trapFocus(e) {
            if (e.key !== "Tab") return;
            const focusables = modal.querySelectorAll(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
            );
            if (focusables.length === 0) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
        modal.addEventListener("keydown", trapFocus);

        overlay.addEventListener("mousedown", e => {
            if (e.target !== overlay) return;
            if (seriesDropdown.isOpen || charDropdown.isOpen) return;
            closePanel();
        });

    overlay.addEventListener("keydown", e => {
        if (e.key === "Escape") closePanel();
    });
}

// ---------------------------------------------------------------------------
// Panel 2 — Trait filter
// ---------------------------------------------------------------------------
async function openTraitPanel(node, filtersData) {
    const overlay = document.createElement("div");
    overlay.classList.add("waifudb-overlay");
    overlay.setAttribute("tabindex", "-1");

    const modal = document.createElement("div");
    modal.classList.add("waifudb-modal", "waifudb-modal-trait");

    modal.innerHTML = `
        <button type="button" class="waifudb-modal-close" aria-label="Close">✕</button><h2>🎨 Trait Filter</h2>
        <div class="waifudb-trait-grid">
            <div>
                <div class="waifudb-trait-grid-label">Series</div>
                <div id="tfSeriesSlot"></div>
            </div>
            <div>
                <div class="waifudb-trait-grid-label">Breast Size</div>
                <div id="tfBreastSlot"></div>
            </div>
            <div>
                <div class="waifudb-trait-grid-label">Eye Color</div>
                <div id="tfEyeSlot"></div>
            </div>
            <div>
                <div class="waifudb-trait-grid-label">Hair Color</div>
                <div id="tfHairSlot"></div>
            </div>
            <div>
                <div class="waifudb-trait-grid-label">Hairstyle</div>
                <div id="tfHairstyleSlot"></div>
            </div>
            <div class="waifudb-trait-search-btn-wrapper">
            <button id="tfSearchBtn" class="waifudb-trait-search-btn">Search</button>
            </div>
            </div>
            <div style="margin-top:8px;">
            <button id="tfClearBtn" type="button" class="waifudb-clear-filters-btn">✕ Clear all filters</button>
            </div>

        <div id="tfResultCount" class="waifudb-trait-results-counter" style="display:none;"></div>
        <div id="tfResultsSlot"></div>

        ${SELECTION_HTML}
        ${CHECKBOX_HTML}
        ${FOOTER_HTML}`;

    document.body.appendChild(overlay);
    overlay.appendChild(modal);
    overlay.focus();

    function makeFilterDrop(slotId, items, placeholder) {
        const drop = createSearchableSelect({ placeholder });
        drop.setItems(items);
        modal.querySelector(slotId).appendChild(drop);
        return drop;
    }

    const seriesDrop   = makeFilterDrop("#tfSeriesSlot",    filtersData.series      || [], "Any");
    const breastDrop   = makeFilterDrop("#tfBreastSlot",    (filtersData.breast_size || []).map(v => ({ value: v, label: v.replace(/_/g, " ") })), "Any");
    const eyeDrop      = makeFilterDrop("#tfEyeSlot",       (filtersData.eye_color   || []).map(v => ({ value: v, label: v.replace(/_/g, " ") })), "Any");
    const hairDrop     = makeFilterDrop("#tfHairSlot",      (filtersData.hair_color  || []).map(v => ({ value: v, label: v.replace(/_/g, " ") })), "Any");
    const hairstyleDrop= makeFilterDrop("#tfHairstyleSlot", (filtersData.hairstyle   || []).map(v => ({ value: v, label: v.replace(/_/g, " ") })), "Any");

    let traitRequest = 0;
    function closePanel() {
        if (!overlay.isConnected) return;
        traitRequest++;
        disposeDropdowns(modal);
        overlay.remove();
    }
    const selectionData = [];
    const selListEl = modal.querySelector("#magikSelectionList");
    wirePreview(modal, selectionData);

    function renderSelectionRow(charData) {
        const row = document.createElement("div");
        row.dataset.charId = charData.char_id;
        row.classList.add("waifudb-selection-row");

        const name = document.createElement("span");
        name.textContent = charData.original_input;
        name.classList.add("waifudb-selection-row-name");
        row.appendChild(name);

        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.textContent = "✏";
        editBtn.title = "Edit " + charData.original_input;
        editBtn.classList.add("waifudb-selection-btn-action");
        editBtn.addEventListener("click", () => {
            const i = selectionData.findIndex(c => c.char_id === charData.char_id);
            if (i === -1) return;
            openEditModal(selectionData[i], updatedChar => {
                selectionData[i] = updatedChar;
                name.textContent = updatedChar.original_input;
                editBtn.title = "Edit " + updatedChar.original_input;
                row.dataset.charId = updatedChar.char_id;
                refreshSelection(modal, selectionData);
            });
        });
        row.appendChild(editBtn);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.textContent = "✕";
        removeBtn.title = "Remove from selection";
        removeBtn.classList.add("waifudb-selection-btn-action", "waifudb-selection-btn-remove");
        removeBtn.addEventListener("click", () => {
            const i = selectionData.findIndex(c => c.char_id === charData.char_id);
            if (i !== -1) selectionData.splice(i, 1);
            row.remove();
            refreshSelection(modal, selectionData);
        });
        row.appendChild(removeBtn);

        return row;
    }

    modal.querySelector("#magikSelClear").addEventListener("click", () => {
        selectionData.length = 0;
        selListEl.innerHTML = "";
        refreshSelection(modal, selectionData);
    });

    modal.querySelector("#tfClearBtn")?.addEventListener("click", () => {
        traitRequest++;
        setLoading(modal, false);
        seriesDrop.reset();
        breastDrop.reset();
        eyeDrop.reset();
        hairDrop.reset();
        hairstyleDrop.reset();
        resultDrop.setItems([]);
        currentResults = [];
        modal.querySelector("#tfResultCount").style.display = "none";
    });

    function addToSelection(charData) {
        if (!charData) return;
        if (selectionData.some(c => c.char_id === charData.char_id)) return;
        selectionData.push(charData);
        selListEl.appendChild(renderSelectionRow(charData));
        refreshSelection(modal, selectionData);
    }

    const resultDrop = createSearchableSelect({
        placeholder: "Select from results…",
        onSelect: (_v, _l, data) => {
            const idx = parseInt(_v, 10);
            const charData = isNaN(idx) ? null : currentResults[idx] || null;
            if (charData) addToSelection(charData);
        },
    });
    modal.querySelector("#tfResultsSlot").appendChild(resultDrop);

    let currentResults = [];
    const resultCountEl = modal.querySelector("#tfResultCount");

    modal.querySelector("#tfSearchBtn").addEventListener("click", async () => {
        const requestId = ++traitRequest;
        showError(modal, "");
        resultDrop.setItems([]);
        resultCountEl.style.display = "none";

        const params = new URLSearchParams();
        if (seriesDrop.getValue())    params.set("series",      seriesDrop.getValue());
        if (breastDrop.getValue())    params.set("breast_size", breastDrop.getValue());
        if (eyeDrop.getValue())       params.set("eye_color",   eyeDrop.getValue());
        if (hairDrop.getValue())      params.set("hair_color",  hairDrop.getValue());
        if (hairstyleDrop.getValue()) params.set("hairstyle",   hairstyleDrop.getValue());

        if (!params.toString()) {
            setLoading(modal, false);
            showError(modal, "Please select at least one filter.");
            return;
        }

        params.set("limit", "200");
        setLoading(modal, true, "Searching…");
        try {
            const res = await fetch(`/custom_character_search/trait_filter?${params}`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `Server returned ${res.status}`);
            }
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            if (requestId !== traitRequest || !overlay.isConnected) return;
            currentResults = Array.isArray(data) ? data : [];

            const cap = 200;
            resultCountEl.textContent = currentResults.length === cap
                ? `Showing top ${cap} results — add more filters to narrow down`
                : `${currentResults.length} character${currentResults.length !== 1 ? "s" : ""} found`;
            resultCountEl.style.display = "block";

            resultDrop.setItems(currentResults.map((c, i) => ({
                value: String(i),
                label: c.original_input,
                thumbnail: `/custom_character_search/thumbnail/${c.char_id}`,
            })));
            setLoading(modal, false);
        } catch (err) {
            if (requestId !== traitRequest || !overlay.isConnected) return;
            setLoading(modal, false);
            showError(modal, "Search failed: " + err.message);
        }
    });

    modal.querySelector(".waifudb-modal-close").addEventListener("click", closePanel);
    modal.querySelector("#magikCopyBtn").addEventListener("click", () => {
        navigator.clipboard.writeText(buildPreviewText(selectionData, modal)).catch(() => showError(modal, "Could not copy tags."));
    });
    modal.querySelector("#magikSearchBtn").addEventListener("click", () => {
        if (writeTagsToNode(node, modal, selectionData))
            closePanel();
    });

    overlay.addEventListener("click", e => { if (e.target === overlay) closePanel(); });
    overlay.addEventListener("keydown", e => {
        if (e.key === "Escape") closePanel();
    });
}

// ---------------------------------------------------------------------------
// Auto-25 options panel
// ---------------------------------------------------------------------------
async function openAutoPanel(node, filtersData) {
    const overlay = document.createElement("div");
    overlay.classList.add("waifudb-overlay");
    overlay.setAttribute("tabindex", "-1");

    const modal = document.createElement("div");
    modal.classList.add("waifudb-modal", "waifudb-modal-trait");

    modal.innerHTML = `
        <h2>🎲 Auto-25 Options</h2>
        <div class="waifudb-trait-grid">
            <div>
                <div class="waifudb-trait-grid-label">Series</div>
                <div id="a25SeriesSlot"></div>
            </div>
        </div>
        <div class="waifudb-overrides-box">
            <label title="Replaces flat_chest, small_breasts and medium_breasts with large_breasts">
                <input type="checkbox" id="a25EnforceLarge" checked> Enforce large breasts
            </label>
        </div>
        <div id="a25LoadingMsg" class="waifudb-loading-msg" style="display:none;">Picking 25…</div>
        <div id="a25ErrorMsg" class="waifudb-error-msg" style="display:none;"></div>
        <div class="waifudb-modal-actions-row">
            <button id="a25GenerateBtn" class="waifudb-save">🎲 Generate 25</button>
            <button id="a25CancelBtn" class="waifudb-cancel">Cancel</button>
        </div>`;

    document.body.appendChild(overlay);
    overlay.appendChild(modal);
    overlay.focus();

    const seriesDrop = createSearchableSelect({ placeholder: "Any series" });
    seriesDrop.setItems(filtersData.series || []);
    modal.querySelector("#a25SeriesSlot").appendChild(seriesDrop);

    const errorEl = modal.querySelector("#a25ErrorMsg");
    const loadingEl = modal.querySelector("#a25LoadingMsg");
    const generateBtn = modal.querySelector("#a25GenerateBtn");

    function setErr(message) {
        errorEl.textContent = message ? "⚠ " + message : "";
        errorEl.style.display = message ? "block" : "none";
    }
    function setBusy(busy) {
        loadingEl.style.display = busy ? "block" : "none";
        generateBtn.disabled = busy;
    }

    function close() {
        if (overlay.isConnected) { disposeDropdowns(modal); overlay.remove(); }
    }

    modal.querySelector("#a25CancelBtn").addEventListener("click", close);

    generateBtn.addEventListener("click", async () => {
        setErr("");
        setBusy(true);

        const series = seriesDrop.getValue();
        const params = new URLSearchParams();
        if (series) params.set("series", series);

        try {
            const res = await fetch(`/custom_character_search/auto_25?${params}`);
            if (!res.ok) throw new Error(`Server returned ${res.status}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            if (!overlay.isConnected) return;
            const characters = data.characters || [];
            if (characters.length === 0) {
                setBusy(false);
                setErr(series ? `No characters found in "${series}".` : "No characters found.");
                return;
            }

            const enforceLarge = modal.querySelector("#a25EnforceLarge").checked;

            // buildTagsForChar reads checkbox state from a modal via
            // "#includeCheckboxes input:checked" — feed it a throwaway
            // container with every tag category enabled (Auto-25 always
            // pulls the full tag set; only the series pool and the
            // large-breasts override are configurable here).
            const fakeModal = document.createElement("div");
            fakeModal.innerHTML = `
                <div id="includeCheckboxes">
                    <input type="checkbox" data-cols="breast_size" checked>
                    <input type="checkbox" data-cols="eye_color" checked>
                    <input type="checkbox" data-cols="hair_color_1,hair_color_2" checked>
                    <input type="checkbox" data-cols="hairstyle_1,hairstyle_2,hairstyle_3,hairstyle_4" checked>
                    <input type="checkbox" data-cols="common_outfits,clothing_pieces" checked>
                    <input type="checkbox" data-cols="clothing_accessories" checked>
                    <input type="checkbox" data-cols="others" checked>
                </div>`;

            const perCharStrings = characters.map(charData =>
                buildTagsForChar(charData, fakeModal, enforceLarge).join(", ")
            );
            const text = perCharStrings.join(",\n\n");

            const charTagsWidget = node.widgets.find(w => w.name === "character_tags");
            if (charTagsWidget) {
                charTagsWidget.value = text;
                charTagsWidget.callback?.(text);
                node.setDirtyCanvas(true, true);
            } else { throw new Error("Could not find character_tags widget."); }

            close();
        } catch (err) {
            setBusy(false);
            setErr("Auto-25 failed: " + err.message);
        }
    });

    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    overlay.addEventListener("keydown", e => {
        if (e.key === "Escape") close();
    });
}

// ---------------------------------------------------------------------------
// Modal launcher
// ---------------------------------------------------------------------------
let cachedFiltersData = null;
let cachedFiltersTime = 0;
const FILTERS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function loadFilters() {
    if (cachedFiltersData && (Date.now() - cachedFiltersTime) < FILTERS_CACHE_TTL) {
        return cachedFiltersData;
    }
    const res = await fetch("/custom_character_search/filters");
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    cachedFiltersData = data;
    cachedFiltersTime = Date.now();
    return data;
}

async function openMagikModal(node, panelType = "search") {
    let filtersData;
    try {
        filtersData = await loadFilters();
    } catch (err) {
        alert(`[WaifuDB] Could not load filters: ${err.message}`);
        return;
    }
    if (panelType === "trait") {
        openTraitPanel(node, filtersData);
    } else if (panelType === "auto") {
        openAutoPanel(node, filtersData);
    } else {
        openSearchPanel(node, filtersData);
    }
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------
app.registerExtension({
    name: "WaifuDB.SearchPanel",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!["Magik.WaifuDB", "WaifuDB"].includes(nodeData.name)) return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);
            if (this._waifuDbInit) return;
            this._waifuDbInit = true;
            const auto25Widget = this.addWidget("button", "Auto-25", "auto_25", () => {
                openMagikModal(this, "auto");
            });
            this.addWidget("button", "🪄 Character Search", "search", () => {
                openMagikModal(this, "search");
            });
            this.addWidget("button", "🎨 Trait Filter", "trait", () => {
                openMagikModal(this, "trait");
            });
        };
    },
});
