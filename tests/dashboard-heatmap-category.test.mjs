import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');
test('heatmap uses the one existing category dropdown without duplicate group choices',()=>{
  assert.match(html,/populateSel\('filter-kategori', uniqueValues\('KATEGORI'\)\.sort\(\)\)/);
  assert.doesNotMatch(html,/__PECAH__|__BOCOR__|__LAIN__|data-heat-category/);
  assert.match(html,/if\(sCat && row\['KATEGORI'\] !== sCat\) return false/);
});

test('map shows category-filtered coordinate coverage and fits matching points',()=>{
  assert.match(html,/filteredData\.forEach\(r => \{/);
  assert.match(html,/\$\{heatPts\.length\} daripada \$\{filteredData\.length\} kes/);
  assert.match(html,/function fitDashboardMapToFilteredCases\(\)/);
  assert.match(html,/if\(isHeatmapMode\) fitDashboardMapToFilteredCases\(\)/);
});
