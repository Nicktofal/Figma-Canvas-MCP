# Prototyping: interactions between frames and components

Use the **`prototype`** tool (or `node.setReactionsAsync` in `execute`). Verified shapes below.

## Typical recipes

**Screen → screen (click, animated)**
`prototype {op:'link', from:<button id>, to:<next frame id>, trigger:'ON_CLICK', transition:{type:'SMART_ANIMATE', duration:0.4, easing:'EASE_OUT'}}`
then mark the entry point: `prototype {op:'flow', from:<first frame id>, name:'Onboarding'}`.

**Hover / press states of a component (variants)**
1. Make a component set with variants, e.g. `State=Default`, `State=Hover`, `State=Pressed` (see `components` skill).
2. On the *Default* variant: `link from=<Default id> to=<Hover id> trigger=MOUSE_ENTER action=change_to transition SMART_ANIMATE 0.15s`
3. On *Hover*: `MOUSE_LEAVE → Default`, `MOUSE_DOWN → Pressed`; on *Pressed*: `MOUSE_UP → Hover`.
Layers must have the **same names and hierarchy** across variants so Smart Animate can tween them.

**Overlay (modal / dropdown / toast)**: `action:'overlay'`, destination = the overlay frame; close with `action:'close'` on a control inside the overlay.

**Back button**: `action:'back'`. **External link**: `action:'url', url:'https://…'`.

**Auto-advance / splash / carousel**: `trigger:'AFTER_TIMEOUT', triggerOptions:{timeout:2}` from a frame to the next.

## Reference
- Triggers: `ON_CLICK`, `ON_HOVER`, `ON_PRESS`, `AFTER_TIMEOUT`, `MOUSE_ENTER/LEAVE/UP/DOWN` (optional `delay` ms), `ON_KEY_DOWN`.
- Actions: `navigate`, `overlay`, `swap`, `change_to`, `scroll_to`, `back`, `close`, `url`.
- Transitions: `SMART_ANIMATE`, `DISSOLVE`, `MOVE_IN`, `MOVE_OUT`, `PUSH`, `SLIDE_IN`, `SLIDE_OUT`, `INSTANT` (directional ones take `direction` LEFT/RIGHT/TOP/BOTTOM).
- A node holds one reaction per trigger type through `prototype link` (a new one replaces the old one with the same trigger). To stack several, use `execute`.
- Check the result with `prototype {op:'list'}` (also shown as `interactions` in `read`).
- Raw API: `await node.setReactionsAsync([{trigger:{type:'ON_CLICK'}, actions:[{type:'NODE', destinationId, navigation:'NAVIGATE', transition:{type:'SMART_ANIMATE', duration:0.4, easing:{type:'EASE_OUT'}}, preserveScrollPosition:false}]}])`.
- Flow starting points: always read, merge, then assign (`figma.currentPage.flowStartingPoints`); assigning a fresh array overwrites existing flows.
- Playing the prototype is done by the user in Figma (Present ▶). The bridge cannot click through it.
