/* script.js — AnimeRat frontend
   Features:
   - Jikan API usage (v4): search, top, seasons, anime details
   - Search suggestions (debounced)
   - Caching via localStorage (TTL)
   - Feed rendering (grid/list view toggle)
   - Modal details with trailer, genres, synopsis
   - Rating stars UI (client-side until Firebase wired)
   - 3-dot menu placeholders for MyList / Notify / Share / Report
   - Load more / pagination
   - Accessible keyboard support for modal
   - Graceful fallback and detailed logging
*/

/* ==========================
   CONFIG
   ========================== */
const API_BASE = 'https://api.jikan.moe/v4';
const CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes
const PAGE_SIZE = 18; // items per fetch for feed

/* ==========================
   HELPERS: caching, DOM, utils
   ========================== */
function nowMs(){ return Date.now(); }

function cacheSet(key, value) {
  const payload = { t: nowMs(), v: value };
  try { localStorage.setItem('animerat:' + key, JSON.stringify(payload)); } catch (e) { /* ignore storage errors */ }
}
function cacheGet(key, maxAge = CACHE_TTL_MS) {
  try {
    const raw = localStorage.getItem('animerat:' + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.t || !parsed.v) return null;
    if ((nowMs() - parsed.t) > maxAge) { localStorage.removeItem('animerat:' + key); return null; }
    return parsed.v;
  } catch (e) { return null; }
}
function cacheRemove(key){ try{ localStorage.removeItem('animerat:' + key); }catch(e){} }

function el(sel){ return document.querySelector(sel); }
function elAll(sel){ return Array.from(document.querySelectorAll(sel)); }
function create(tag, attrs={}, children=[]) {
  const d = document.createElement(tag);
  for (const k of Object.keys(attrs||{})) {
    if (k === 'class') d.className = attrs[k];
    else if (k === 'html') d.innerHTML = attrs[k];
    else d.setAttribute(k, attrs[k]);
  }
  (Array.isArray(children) ? children : [children]).forEach(c => {
    if (typeof c === 'string') d.appendChild(document.createTextNode(c));
    else if (c instanceof Node) d.appendChild(c);
  });
  return d;
}

function safeText(s){ return s ? String(s) : ''; }

function toShort(s, n=140){
  if (!s) return '';
  s = s.replace(/\s+/g,' ').trim();
  return s.length > n ? s.slice(0,n).trim() + '...' : s;
}

/* Debounce */
function debounce(fn, wait=220){
  let t;
  return function(...a){ clearTimeout(t); t = setTimeout(()=>fn.apply(this,a), wait); };
}

/* Pretty date */
function timeAgo(ts){
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const s = Math.floor(diff/1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s/60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m/60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h/24);
  return d + 'd ago';
}

/* Small toast */
function toast(msg, time=2200){
  let t = el('#__animerat_toast');
  if (!t) {
    t = create('div', { id: '__animerat_toast', class: 'animerat-toast' });
    Object.assign(t.style, {
      position: 'fixed', right: '18px', bottom: '18px',
      background: 'linear-gradient(90deg,#ff63b8,#ff2b9e)',
      color: '#fff', padding: '10px 14px', borderRadius: '12px', zIndex: 9999, boxShadow: '0 10px 30px rgba(0,0,0,0.5)'
    });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._h);
  t._h = setTimeout(()=>{ t.style.opacity = '0'; }, time);
}

/* ==========================
   UI REFS
   ========================== */
const refs = {
  searchInput: el('#globalSearch'),
  searchSuggest: el('#searchSuggest'),
  feed: el('#feed'),
  heroCard: el('#hero-card'),
  loadMoreBtn: el('#loadMoreBtn'),
  sortSelect: el('#sortSelect'),
  gridViewBtn: el('#gridView'),
  listViewBtn: el('#listView'),
  ctaTop: el('#ctaTop'),
  ctaAiring: el('#ctaAiring'),
  navLinks: elAll('.navlink'),
  genreList: el('#genreList'),
  modal: el('#modal'),
  modalBackdrop: el('.modal-backdrop'),
  modalPanel: el('.modal-panel'),
  modalClose: el('.modal-close'),
  modalTitle: el('#modalTitle'),
  modalCover: el('#modalCover'),
  modalGenres: el('#modalGenres'),
  modalSynopsis: el('#modalSynopsis'),
  modalScore: el('#modalScore'),
  modalEpisodes: el('#modalEpisodes'),
  modalStatus: el('#modalStatus'),
  modalTrailerWrap: el('#modalTrailerWrap'),
  modalTrailer: el('#modalTrailer'),
  reviewsList: el('#reviewsList'),
  reviewText: el('#reviewText'),
  ratingStars: el('#ratingStars'),
  submitReviewBtn: el('#submitReview'),
  yearSpan: el('#year'),
  signinBtn: el('#signinBtn'),
  randomBtn: el('#randomBtn'),
  refreshBtn: el('#refreshBtn'),
  topFeed: el('#topFeed'),
  airingFeed: el('#airingFeed'),
  upcomingFeed: el('#upcomingFeed'),
  moviesFeed: el('#moviesFeed'),
  genresFeed: el('#genresFeed'),
  myListFeed: el('#myListFeed'),
  main: el('#main'),
  sidebar: el('#sidebar'),
};

/* Template nodes */
const cardTpl = el('#cardTemplate');
const reviewTpl = el('#reviewTemplate');

/* ==========================
   APP STATE
   ========================== */
const state = {
  page: 1,
  feedType: 'home', // home/top/airing/upcoming/movies/genres/mylist
  query: '',
  view: 'grid', // or list
  sort: 'popularity',
  genreFilter: null,
  runningFetch: false,
  lastSearchResults: [],
  detailsCache: {},
  feeds: { home: [], top: [], airing: [], upcoming: [], movies: [], genres: [], mylist: [] },
};

/* ==========================
   API CALLS (with caching + backoff)
   ========================== */

async function apiFetch(path, params = {}, useCacheKey = null, ttl = CACHE_TTL_MS) {
  // Build URL
  const url = new URL(API_BASE + path);
  Object.keys(params || {}).forEach(k => { if (params[k] !== undefined && params[k] !== null) url.searchParams.set(k, params[k]); });

  const cacheKey = useCacheKey || ('url:' + url.toString());
  const cached = cacheGet(cacheKey, ttl);
  if (cached) return cached;

  // basic fetch with retry once
  try {
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    cacheSet(cacheKey, data);
    return data;
  } catch (err) {
    console.warn('Primary fetch failed for', url.toString(), err);
    // try again after small delay
    await new Promise(r => setTimeout(r, 450));
    try {
      const res2 = await fetch(url.toString());
      if (!res2.ok) throw new Error('HTTP ' + res2.status);
      const data2 = await res2.json();
      cacheSet(cacheKey, data2);
      return data2;
    } catch (err2) {
      console.error('Retry fetch failed for', url.toString(), err2);
      throw err2;
    }
  }
}

async function searchAnime(q, limit = 12) {
  if (!q) return null;
  const path = '/anime';
  const params = { q: q, limit, page: 1 };
  return apiFetch(path, params, `search:${q}:${limit}`, 1000 * 60 * 5);
}

async function getTopAnime(page = 1, limit = PAGE_SIZE) {
  return apiFetch('/top/anime', { page, limit }, `top:${page}:${limit}`);
}

async function getSeasonsNow() {
  return apiFetch('/seasons/now', {}, 'seasons:now', CACHE_TTL_MS);
}

async function getSeasonsUpcoming() {
  return apiFetch('/seasons/upcoming', {}, 'seasons:upcoming', CACHE_TTL_MS);
}

async function getAnimeDetails(id) {
  if (!id) throw new Error('No id');
  if (state.detailsCache[id]) return state.detailsCache[id];
  const data = await apiFetch(`/anime/${id}/full`, {}, `anime:${id}`, CACHE_TTL_MS * 24);
  state.detailsCache[id] = data;
  return data;
}

async function getGenresList() {
  // Jikan provides a genres endpoint
  return apiFetch('/genres/anime', {}, 'genres:list', CACHE_TTL_MS * 24 * 3);
}

/* ==========================
   RENDERING: cards, feeds, hero
   ========================== */

function renderCard(anime) {
  const node = cardTpl.content.cloneNode(true);
  const card = node.querySelector('.anime-card');
  const img = node.querySelector('.card-img');
  const title = node.querySelector('.card-title');
  const score = node.querySelector('.card-score');
  const eps = node.querySelector('.card-episodes');
  const synopsis = node.querySelector('.card-synopsis');
  const genresWrap = node.querySelector('.card-genres');
  const moreBtn = node.querySelector('.card-more');

  const id = anime.mal_id || anime.malId || (anime.id || anime.animeId);
  img.src = (anime.images && anime.images.jpg && anime.images.jpg.image_url) || (anime.image_url) || '';
  img.alt = anime.title || 'Anime cover';
  title.textContent = anime.title || 'Untitled';
  score.textContent = anime.score ? `★ ${anime.score}` : '—';
  eps.textContent = anime.episodes ? `${anime.episodes} eps` : '';
  synopsis.textContent = toShort(anime.synopsis || (anime.background || ''), 160);

  // genres
  const gList = (anime.genres || anime.theme || anime.demographics || []);
  genresWrap.innerHTML = '';
  (gList.slice(0,4) || []).forEach(g => {
    const s = create('span', { class: 'chip', html: safeText(g.name || g) });
    s.className = 'chip';
    s.style.cssText = 'padding:4px 8px;border-radius:999px;background:rgba(255,255,255,0.02);color:var(--muted);font-size:0.78rem;margin-right:6px';
    genresWrap.appendChild(s);
  });

  // interactions:
  card.dataset.id = id;
  // Open details modal
  card.addEventListener('click', (e) => {
    // ignore click if target is more menu button
    if (e.target.closest('.card-more')) return;
    openDetailsModal(id);
  });
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDetailsModal(id); });

  // more menu placeholder
  moreBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    showCardMenu(id, moreBtn);
  });

  return node;
}

function renderFeedInto(containerEl, items = []) {
  // Clear
  containerEl.innerHTML = '';
  if (!items || items.length === 0) {
    containerEl.innerHTML = `<div class="empty-note" style="padding:18px;color:var(--muted)">No items.</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  items.forEach(a => {
    frag.appendChild(renderCard(a));
  });
  containerEl.appendChild(frag);
}

/* Hero card render (featured) */
function renderHero(anime) {
  refs.heroCard.innerHTML = '';
  if (!anime) {
    refs.heroCard.innerHTML = `<div class="hero-placeholder">No featured anime</div>`;
    return;
  }
  const wrapper = create('div', { class: 'hero-feature fade-in' });
  const cover = create('img', { class: 'cover-img', src: anime.images?.jpg?.image_url || '', alt: anime.title || 'cover' });
  const title = create('h3', { html: safeText(anime.title) });
  title.style.color = 'var(--text)';
  const desc = create('p', { html: toShort(anime.synopsis || '', 240) });

  const btnA = create('button', { class: 'btn btn-primary', html: 'Details' });
  btnA.addEventListener('click', () => openDetailsModal(anime.mal_id));

  const btnB = create('button', { class: 'btn btn-ghost', html: 'Add to MyList' });
  btnB.addEventListener('click', async () => {
    try {
      if (window.AnimeRatFirebase && window.AnimeRatFirebase.addToMyList) {
        await window.AnimeRatFirebase.addToMyList(anime.mal_id, { title: anime.title });
        toast('Added to MyList');
      } else {
        toast('Sign in to save to MyList');
      }
    } catch (err) {
      toast('Failed: ' + (err.message || err));
    }
  });

  const infoWrap = create('div', {}, [title, desc, create('div', { class: 'hero-ctas' }, [btnA, btnB])]);
  wrapper.appendChild(cover);
  wrapper.appendChild(infoWrap);
  refs.heroCard.appendChild(wrapper);
}

/* ==========================
   DETAILS MODAL
   ========================== */

async function openDetailsModal(id) {
  if (!id) return;
  refs.modal.setAttribute('aria-hidden', 'false');

  // lock body scroll
  document.documentElement.style.overflow = 'hidden';

  try {
    const resp = await getAnimeDetails(id);
    const anime = resp && resp.data ? resp.data : null;
    if (!anime) {
      refs.modalTitle.textContent = 'Not found';
      refs.modalSynopsis.textContent = '';
      return;
    }

    refs.modalTitle.textContent = anime.title || '';
    refs.modalCover.src = anime.images?.jpg?.image_url || '';
    refs.modalCover.alt = anime.title || 'cover';
    refs.modalScore.textContent = anime.score ? `Score: ${anime.score}` : 'Score: —';
    refs.modalEpisodes.textContent = `Episodes: ${anime.episodes || '—'}`;
    refs.modalStatus.textContent = `Status: ${anime.status || '—'}`;
    // genres
    refs.modalGenres.innerHTML = '';
    (anime.genres || []).forEach(g => {
      const b = create('span', { html: safeText(g.name) });
      b.className = 'badge';
      refs.modalGenres.appendChild(b);
    });
    // synopsis
    refs.modalSynopsis.innerHTML = anime.synopsis ? `<p>${safeText(anime.synopsis)}</p>` : '<p>No synopsis available.</p>';

    // trailer
    if (anime.trailer && anime.trailer.embed_url) {
      refs.modalTrailerWrap.hidden = false;
      refs.modalTrailer.innerHTML = `<iframe src="${anime.trailer.embed_url}" width="100%" height="300" frameborder="0" allowfullscreen></iframe>`;
    } else {
      refs.modalTrailerWrap.hidden = true;
      refs.modalTrailer.innerHTML = '';
    }

    // reviews placeholder load (if Firebase available it should stream)
    refs.reviewsList.innerHTML = '';
    if (window.AnimeRatFirebase && window.AnimeRatFirebase.streamReviewsForAnime) {
      // live stream reviews
      if (refs._reviewsUnsub) refs._reviewsUnsub();
      refs._reviewsUnsub = window.AnimeRatFirebase.streamReviewsForAnime(String(id), (reviews) => {
        renderReviews(reviews || []);
      });
    } else {
      // local placeholder review
      renderReviews([]);
    }

    // rating stars setup
    setupRatingStars();

  } catch (err) {
    console.error('Details load failed', err);
    refs.modalTitle.textContent = 'Error loading details';
    refs.modalSynopsis.textContent = 'Could not load details. Try again later.';
  }
}

function closeDetailsModal() {
  refs.modal.setAttribute('aria-hidden', 'true');
  document.documentElement.style.overflow = '';
  // cleanup
  refs.modalTrailer.innerHTML = '';
  if (refs._reviewsUnsub) { try{ refs._reviewsUnsub(); }catch(e){} refs._reviewsUnsub = null; }
}

/* Reviews rendering (client-only unless firebase hooked) */
function renderReviews(reviews) {
  refs.reviewsList.innerHTML = '';
  if (!reviews || reviews.length === 0) {
    refs.reviewsList.innerHTML = `<div class="empty-note" style="color:var(--muted)">No reviews yet. Be the first!</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  reviews.forEach(r => {
    const node = reviewTpl.content.cloneNode(true);
    const root = node.querySelector('.review');
    root.querySelector('.review-user').textContent = r.username || r.userId || 'Guest';
    root.querySelector('.review-rating').textContent = r.rating ? `★ ${r.rating}` : '';
    root.querySelector('.review-text').textContent = r.text || '';
    const t = root.querySelector('.review-time');
    t.textContent = r.createdAt ? timeAgo(r.createdAt.seconds ? r.createdAt.seconds * 1000 : r.createdAt) : '';
    frag.appendChild(node);
  });
  refs.reviewsList.appendChild(frag);
}

/* Rating stars UI */
function setupRatingStars() {
  refs.ratingStars.innerHTML = '';
  let current = 0;
  for (let i=1;i<=5;i++){
    const btn = create('button', { type: 'button', html: '★' });
    btn.dataset.value = i;
    btn.addEventListener('click', async (e) => {
      current = i;
      updateStars();
    });
    btn.addEventListener('mouseover', (e) => {
      const v = Number(btn.dataset.value);
      highlightStars(v);
    });
    btn.addEventListener('mouseout', (e) => updateStars());
    refs.ratingStars.appendChild(btn);
  }
  function highlightStars(n){
    const nodes = refs.ratingStars.querySelectorAll('button');
    nodes.forEach((b, idx) => {
      b.classList.toggle('active', (idx+1) <= n);
    });
  }
  function updateStars(){
    const nodes = refs.ratingStars.querySelectorAll('button');
    nodes.forEach((b, idx) => {
      b.classList.toggle('active', (idx+1) <= current);
    });
  }

  // submit handler
  refs.submitReviewBtn.onclick = async () => {
    const text = refs.reviewText.value.trim();
    const rating = Array.from(refs.ratingStars.children).filter(b => b.classList.contains('active')).length;
    const animeId = refs.modal.dataset.animeId;
    if (!animeId) { toast('Missing anime id'); return; }
    if (!rating && !text) { toast('Provide rating or review text'); return; }

    if (window.AnimeRatFirebase && window.AnimeRatFirebase.submitReview) {
      try {
        await window.AnimeRatFirebase.submitReview(animeId, rating, text);
        toast('Review submitted');
        refs.reviewText.value = '';
      } catch (err) {
        console.error('Submit review error', err);
        toast('Failed to submit review: ' + (err.message || err));
      }
    } else {
      // local fallback - append to list (client-only)
      const fake = { username: 'You (local)', rating, text, createdAt: Date.now() };
      renderReviews([fake].concat([]));
      toast('Saved locally (no account)');
      refs.reviewText.value = '';
    }
  };
}

/* ==========================
   CARD MENU (3-dot) - placeholders
   ========================== */
function showCardMenu(animeId, anchorEl) {
  // Simple native menu using prompt for now (replace with better UI later)
  const action = prompt('Options: (1) Add to MyList, (2) Notify me, (3) Share URL, (4) Report\nEnter 1-4:');
  if (!action) return;
  if (action === '1') {
    if (window.AnimeRatFirebase && window.AnimeRatFirebase.addToMyList) {
      window.AnimeRatFirebase.addToMyList(animeId, { title: 'unknown' }).then(()=>toast('Added')).catch(e=>toast('Add failed'));
    } else {
      toast('Sign in to save to MyList');
    }
  } else if (action === '2') {
    if (window.AnimeRatFirebase && window.AnimeRatFirebase.requestAndSaveFCMToken) {
      // toggling subscribe is app-specific; we'll just save a token here
      window.AnimeRatFirebase.requestAndSaveFCMToken().then(()=>toast('Notifications enabled')).catch(e=>toast('Notif failed'));
    } else {
      toast('Notifications not setup');
    }
  } else if (action === '3') {
    const url = `https://myanimelist.net/anime/${animeId}`;
    navigator.clipboard?.writeText(url).then(()=>toast('URL copied to clipboard')).catch(()=>prompt('Copy this URL', url));
  } else if (action === '4') {
    // report flow placeholder
    toast('Reported (placeholder)');
  }
}

/* ==========================
   SEARCH SUGGESTIONS & HANDLING
   ========================== */
const debouncedSuggest = debounce(async (q) => {
  if (!q || q.length < 2) { refs.searchSuggest.classList.remove('visible'); refs.searchSuggest.innerHTML = ''; return; }
  try {
    const res = await searchAnime(q, 8);
    const items = res && res.data ? res.data : [];
    renderSuggestions(items.slice(0,6));
  } catch (err) {
    console.error('Suggest error', err);
    refs.searchSuggest.classList.remove('visible');
    refs.searchSuggest.innerHTML = '';
  }
}, 240);

function renderSuggestions(items) {
  refs.searchSuggest.innerHTML = '';
  if (!items || items.length === 0) { refs.searchSuggest.classList.remove('visible'); return; }
  items.forEach(it => {
    const li = create('li', { role: 'option' });
    li.textContent = it.title;
    li.addEventListener('click', () => {
      refs.searchInput.value = it.title;
      refs.searchSuggest.classList.remove('visible');
      performSearch(it.title);
    });
    refs.searchSuggest.appendChild(li);
  });
  refs.searchSuggest.classList.add('visible');
}

/* ==========================
   SEARCH / FEED LOADERS
   ========================== */
async function performSearch(q) {
  if (!q || q.trim().length === 0) return;
  state.query = q.trim();
  state.page = 1;
  try {
    const res = await searchAnime(state.query, PAGE_SIZE);
    const items = res && res.data ? res.data : [];
    state.feeds.home = items;
    state.lastSearchResults = items;
    r