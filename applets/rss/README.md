# rss

Your feeds as one newest-first river.

The feed list is `~/.config/kona/rss.toml` — a list of URLs, or tables when you
want to name a feed:

```toml
feeds = ["https://news.ycombinator.com/rss"]

[[feeds]]
name = "xkcd"
url  = "https://xkcd.com/atom.xml"
```

RSS 2.0 and Atom both work. Feeds are merged and refreshed every five minutes;
`/` filters the river, `o` opens the selected item in a browser.

```sh
kona rss
kona call rss refresh '{}'
kona call rss search '{"q":"bun"}'
kona call rss open '{"index":0}'
```
