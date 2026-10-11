/* ============================================================
   layout.js — NEW(v3.1): screen modes for a foldable.

   One definition of "unfolded" shared by CSS and JS. Tuned for the Galaxy
   Z Fold 8 Ultra: cover ≈ 411 CSS px wide, inner ≈ 860 (portrait) / 955
   (landscape). The old 560px breakpoint dated from the Fold 6 (inner
   ≈ 620px); 700px sits safely between the two screens at any Samsung
   "Screen zoom" setting. Keep WIDE_MIN in sync with the @media rules in
   index.html.

   Postures (Viewport Segments API, Chromium 125+ on foldables):
     - 'flat'     — one segment (cover, or inner fully open)
     - 'book'     — half-folded, hinge vertical: left | right segments
     - 'tabletop' — half-folded, hinge horizontal: top / bottom segments
   Everything degrades to 'flat' where the API is missing.
   ============================================================ */

export const WIDE_MIN = 700;
export const WIDE_QUERY = `(min-width: ${WIDE_MIN}px)`;

const mm = (q) => (typeof window !== 'undefined' && window.matchMedia) ? window.matchMedia(q) : null;

export function isWide(){ return !!mm(WIDE_QUERY)?.matches; }

export function posture(){
  if (mm('(vertical-viewport-segments: 2)')?.matches) return 'tabletop';
  if (mm('(horizontal-viewport-segments: 2)')?.matches) return 'book';
  return 'flat';
}

// Fires on fold / unfold (crossing the breakpoint) and posture changes.
export function onLayoutChange(fn){
  const lists = [WIDE_QUERY, '(vertical-viewport-segments: 2)', '(horizontal-viewport-segments: 2)']
    .map(mm).filter(Boolean);
  const handler = () => fn({ wide: isWide(), posture: posture() });
  for (const l of lists){
    if (l.addEventListener) l.addEventListener('change', handler);
    else if (l.addListener) l.addListener(handler);
  }
  return handler;
}

// Mirror the mode onto <body> so CSS can key off posture too.
export function applyLayoutClasses(){
  const b = typeof document !== 'undefined' && document.body;
  if (!b) return;
  const p = posture();
  b.classList.toggle('is-wide', isWide());
  b.classList.toggle('posture-book', p === 'book');
  b.classList.toggle('posture-tabletop', p === 'tabletop');
}

// About → Display: what the device actually reports (to tune breakpoints).
export function screenInfo(){
  const w = window.innerWidth, h = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const standalone = !!mm('(display-mode: standalone)')?.matches;
  return {
    css: `${w} × ${h}`,
    dpr: Math.round(dpr * 1000) / 1000,
    physical: `${Math.round(w * dpr)} × ${Math.round(h * dpr)}`,
    screen: typeof screen !== 'undefined' ? `${screen.width} × ${screen.height}` : '—',
    orientation: (typeof screen !== 'undefined' && screen.orientation?.type) || (w > h ? 'landscape' : 'portrait'),
    mode: isWide() ? 'Unfolded layout' : 'Folded / phone layout',
    posture: posture(),
    standalone
  };
}
