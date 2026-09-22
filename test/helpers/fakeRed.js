const path = require("node:path");

/**
 * Load a node file against a fake RED and construct one instance.
 *
 * Admin routes the file registers through RED.httpAdmin.<verb>(path,
 * ...handlers) are collected on the returned node as `node.adminRoutes`
 * - path -> the handler array as registered, needsPermission's guard
 * included as a pass-through - so a test can drive an endpoint the way
 * it drives the input listener. Attached to the node rather than returned
 * beside it because every caller takes the return value as the node.
 */
function loadNode(file, config = {}, { id, comms } = {}) {
	const routes = {};
	const RED = {
		comms,
		httpAdmin: {
			get(path, ...handlers) {
				routes[path] = handlers;
			},
			post(path, ...handlers) {
				routes[path] = handlers;
			},
		},
		auth: {
			needsPermission: () => (req, res, next) => next(),
		},
		nodes: {
			createNode(node, cfg) {
				if (id) node.id = id;
				node.config = cfg;
				node.listeners = {};
				node.on = (evt, fn) => {
					node.listeners[evt] = fn;
				};
				node.send = () => {};
				node.error = () => {};
				node.warn = () => {};
				node.log = () => {};
				node.status = () => {};
			},
			registerType(_name, ctor) {
				RED.nodes.ctor = ctor;
			},
		},
	};
	require(path.join(__dirname, "..", "..", file))(RED);
	const node = new RED.nodes.ctor(config);
	node.adminRoutes = routes;
	return node;
}

module.exports = { loadNode };
