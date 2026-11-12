# Motion principles + how to build them in Figma

Animate to explain change (what appeared, moved, or is clickable), not to decorate. If motion has no job, leave it out. One authored moment per screen beats effects everywhere.

## Principles (the classic 12, as rules)
- **Easing, never linear** (except loops and progress). Arriving: ease-out. Leaving: ease-in. Moving between two on-screen points: ease-in-out. Modern default `cubic-bezier(0.16, 1, 0.3, 1)`.
- **Timing sets weight.** Feedback 100–150 ms · state change 150–300 · panel/overlay 300–500 · authored entrance 500–800. Exits ~30% faster than entrances; longer distance or bigger object = longer.
- **Anticipation + follow-through.** A small counter-move before a big action, a slight settle after (spring). Subtle in product UI, larger in playful/brand work.
- **Squash & stretch / secondary action.** Press 0.96–0.98, hover 1.02–1.04; a second element (shadow, icon, label) reacts slightly later so it feels physical.
- **Arcs.** Natural motion curves: give x and y different easings instead of a straight line.
- **Staggering.** List siblings enter 30–60 ms apart, total ≤ 400 ms, overlapping. Never stagger unrelated elements or move everything at once.
- **Staging.** Only the most important thing moves; the rest holds. Direction stays consistent (enter from the side the user came from).
- **Exaggeration** only for expressive brands. No bounce/elastic by reflex, no fade-up on every section, no parallax on text.
- **Loops/ambient:** 2.5–4 s, seamless (end = start), stoppable if > 5 s.
- Reduced-motion version: gentler, not absent. Content must stay readable in the static frame.
- Animate transform/opacity-like properties (position, scale, rotation, opacity), not layout for fun.

## Figma recipes
1. **Interactions (hover/press/toggle/modal):** component variants with identical layer names + `prototype link` `SMART_ANIMATE`, 0.15–0.4 s, `EASE_OUT`, `{bezier:[0.16,1,0.3,1]}` or `{spring:{mass:1,stiffness:260,damping:22}}`. The user plays it with Present ▶.
2. **Timeline animation (video, GIF, loops, brand motion):** `motion {op:'animate', nodeId:<top-level frame>, tracks:[{target:'Layer', prop:'opacity'|'x'|'y'|'scale'|'rotation'|'width'|'radius'…, keys:[[seconds, value, easing?],…]}], duration, playback:{loop:true}}`. x/y/rotation are offsets from the static layout. Presets: `motion {op:'styles'}` then `apply` (TextStagger for headlines, Path for line drawing). Output: `export {format:'MP4'|'GIF'|'WEBM'}` (Figma window in front).
3. **What the timeline cannot do** (colour tweens, custom physics, per-frame logic): `capture_animation` with `tracks` (easings: easeOutExpo, easeInOutCubic, easeOutBack, `{spring}`, `[x1,y1,x2,y2]`…) or `code`; encodes mp4/gif/webm locally and can use the native timeline with `timeline:true`.
4. Keep layer names and hierarchy identical between states, otherwise Smart Animate cannot match them. Name layers by role.
5. Leave the frame in a good still state: PNG export and thumbnails show the static layout.
