# Live Data world map base (optional)

The Live Data tab's world map (`/data-toolbox` → Live Data) uses **Leaflet with
`L.CRS.Simple`** over the bounds `[[-90,-180],[90,180]]`, so a marker placed at
`[lat, lon]` lands at the geographically correct spot. **No external map tiles are
fetched** — this is the operator decision for the buildout (TODO 0287): the map must
work offline on the LAN with no third-party tile server.

The base is a **drawn graticule** (lat/lon grid + equator), which needs no asset and
does not probe an optional missing image. This keeps the browser console and network
panel clean. A future raster basemap must be introduced as an explicit, checked-in
self-hosted asset rather than a runtime 404 fallback.
