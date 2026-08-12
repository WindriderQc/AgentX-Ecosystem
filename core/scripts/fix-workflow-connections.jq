# Build a map of node ID to node name
(.nodes | map({(.id): .name}) | add) as $idToName |

# Transform the workflow
{
  name,
  nodes,
  connections: (
    .connections |
    # Convert connection keys from IDs to names
    to_entries |
    map({
      key: ($idToName[.key] // .key),
      value: (
        .value |
        # For each connection type (main, etc)
        to_entries |
        map({
          key: .key,
          value: (
            .value |
            map(
              map(
                # Convert "node" field from ID to name
                if .node then
                  .node = ($idToName[.node] // .node)
                else
                  .
                end
              )
            )
          )
        }) |
        from_entries
      )
    }) |
    from_entries
  ),
  settings,
  staticData,
  meta,
  tags
}
