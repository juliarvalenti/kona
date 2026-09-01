# weather

Current conditions and the week ahead, from open-meteo — no account, no key.

```sh
kona weather
kona call weather setLocation '{"q":"Lisbon"}'   # geocoded
kona call weather locate '{}'                    # guess from the IP address
kona call weather units '{"fahrenheit":true}'
kona call weather open '{"index":1}'             # drill into a day
```

`r` refreshes, `/` searches for a place, `u` flips units, `→` opens a day.
