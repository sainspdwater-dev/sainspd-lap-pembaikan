# Worker fixes to apply in Cloudflare Quick Edit

These changes are deliberately small and auditable. They do not introduce an
LLM or claim hydraulic modelling that the available data cannot support.

## 1. Preserve missing numeric values

Replace `safeNumber` with:

```js
function safeNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
```

Replace the manual flow fallback with:

```js
const manualFlow = safeNumber(params.avgMnf) ?? safeNumber(params.avgFlow);
```

This prevents a blank MNF field from becoming a real zero and blocking the
fallback to average flow.

## 2. Aggregate de-duplicated asset geometry

In the asset-profile aggregation query only, replace:

```sql
FROM water_assets
```

with:

```sql
FROM water_assets_unique
```

Do not replace queries that require the original row `id`.

## 3. Handle the configured cron trigger

Add this method to the default export object next to `fetch`:

```js
async scheduled(controller, env, ctx) {
  console.log(JSON.stringify({
    event: 'scheduled_health_check',
    cron: controller.cron,
    scheduledTime: controller.scheduledTime
  }));
}
```

This makes the existing 20-minute trigger valid and stops the repeated
`Handler does not export a scheduled() function` exception. It performs no
data mutation.

## 4. D1 prerequisite

Run `migrations/0001_monitoring_schema.sql` and
`migrations/0002_water_assets_quality_views.sql` before deploying these Worker
changes.
