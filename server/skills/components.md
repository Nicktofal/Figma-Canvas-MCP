# Components, variants, instances

```js
const comp = figma.createComponent();           // or figma.createComponentFromNode(existingFrame)
comp.name = 'Button/Primary';
const key = comp.addComponentProperty('label', 'TEXT', 'Button');
textNode.componentPropertyReferences = { characters: key };
const inst = comp.createInstance();
inst.setProperties({ [key]: 'Save' });

// variants
const a = figma.createComponent(); a.name = 'Size=M, State=Default';
const b = figma.createComponent(); b.name = 'Size=M, State=Hover';
const set = figma.combineAsVariants([a, b], figma.currentPage);
set.name = 'Button';
```
- Build the visual with `render_html`, then convert the resulting frame: `figma.createComponentFromNode(await figma.getNodeByIdAsync(id))`.
- Library components: `await figma.importComponentByKeyAsync(key)` (only for libraries enabled in the file).
- Instance overrides: edit children of the instance directly; `inst.resetOverrides()` clears them.
- Find things: `figma.currentPage.findAllWithCriteria({types:['COMPONENT']})`, `findOne`, `findAll(n => n.name.includes('x'))`.
