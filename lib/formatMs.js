/**
 * The time a node shows in its status: milliseconds under a second,
 * seconds with two decimals from there, so `84ms` and `1.23s` read at a
 * glance next to the verdict. Every vision node ends its per-frame status
 * with ` · <time>` - the wall-clock time from the message arriving to the
 * status being set, previews and encoding included, so what the editor
 * shows is what the flow waits for.
 */
function formatMs(ms) {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

module.exports = { formatMs };
