// Fixtures Sonar sets this while analysing on the fork path, where nothing may run the analysed code.
if (process.env.SONAR_FORK_ANALYSIS_TRAP) {
  require("node:fs").appendFileSync(
    process.env.SONAR_FORK_ANALYSIS_TRAP,
    `${__filename} ran\n`,
  );
  throw new Error("The fork path ran the analysed code");
}

module.exports = {};
