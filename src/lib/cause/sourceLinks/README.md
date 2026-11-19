# Source links

An optional record channel binds a recorded check to a precise output write and to an input in the consumer's view. The check has an explicit standing. These links stay outside the dependency walk and its ranking.

- Admission and row readers narrow the wire to bounded data properties.
- Replay uses the existing verb fold and read-window placement. A committed row must occupy a new position in accounted history.
- The host grants complete output, witness, served-write and input-view locators before replay. Resolution rechecks grants when it returns evidence. Origin disclosure has its own grant.
- Projection keeps evidence and gaps separate from recorded graph edges and their budget.

The synthetic contract data is shipped at `dist/fixtures/source-links-v1.json` inside the installed package. Resolve it relative to the directory of `foottrace/package.json`. It includes sample committed rows, a bound write and the permitted check pairs. Both the reader tests and the producer can use those same rows.

```js
const { readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const manifest = require.resolve('foottrace/package.json');
const fixture = JSON.parse(
  readFileSync(join(dirname(manifest), 'dist/fixtures/source-links-v1.json'), 'utf8'),
);
```
