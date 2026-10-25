// Fork versions never load the upstream updater or use its release feed.
function isForkBuild(version) {
	return typeof version === "string" && /-fork(\.|$)/.test(version);
}

module.exports = { isForkBuild };
