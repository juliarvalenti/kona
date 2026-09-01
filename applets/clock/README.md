# clock

Every city you care about, at a glance — a hero time for the selected zone and a
row per city with its offset and day delta.

```sh
kona clock
kona call clock add '{"tz":"Europe/Lisbon"}'    # an IANA zone, or a catalog name
kona call clock list '{"tz":"Asia/Kathmandu"}'  # read any zone without adding it
kona call clock format '{"hour12":true}'
```

In the TUI, `a` opens the city picker (type to filter, `enter` adds), `d`
removes the selected city and `s` sorts the board west → east.
