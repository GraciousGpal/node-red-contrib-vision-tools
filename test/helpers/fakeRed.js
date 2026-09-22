const path = require("node:path");

function loadNode(file, config = {}, { id, comms } = {}) {
	const RED = {
		comms,
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
	return new RED.nodes.ctor(config);
}

module.exports = { loadNode };
