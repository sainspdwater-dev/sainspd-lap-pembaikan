import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');
const source=html.match(/function categoryMatchesFilter\(category, selected\) \{[\s\S]*?\n        \}(?=\n\n        function applyFilters)/)?.[0];
assert.ok(source,'category filtering function is present');
const categoryMatchesFilter=Function(`${source}; return categoryMatchesFilter;`)();

test('heatmap category shortcuts include every case in the chosen category',()=>{
  assert.equal(categoryMatchesFilter('PAIP PECAH','__PECAH__'),true);
  assert.equal(categoryMatchesFilter('Pecah','__PECAH__'),true);
  assert.equal(categoryMatchesFilter('Paip Bocor','__PECAH__'),false);
  assert.equal(categoryMatchesFilter('PAIP BOCOR','__BOCOR__'),true);
  assert.equal(categoryMatchesFilter('LAIN-LAIN','__LAIN__'),true);
  assert.equal(categoryMatchesFilter('PECAH','__LAIN__'),false);
  assert.equal(categoryMatchesFilter('PAIP PECAH',''),true);
  assert.equal(categoryMatchesFilter('PAIP PECAH','PAIP PECAH'),true);
  assert.equal(categoryMatchesFilter('Pecah','PAIP PECAH'),false);
});

test('map buttons use the same dashboard filter, show coordinate coverage and fit filtered points',()=>{
  for(const category of ['__PECAH__','__BOCOR__','__LAIN__'])
    assert.ok(html.includes(`data-heat-category="${category}"`));
  assert.match(html,/document\.getElementById\('filter-kategori'\)\.value = button\.dataset\.heatCategory/);
  assert.match(html,/if\(!categoryMatchesFilter\(row\['KATEGORI'\], sCat\)\) return false/);
  assert.match(html,/filteredData\.forEach\(r => \{/);
  assert.match(html,/\$\{heatPts\.length\} daripada \$\{filteredData\.length\} kes/);
  assert.match(html,/function fitDashboardMapToFilteredCases\(\)/);
});
