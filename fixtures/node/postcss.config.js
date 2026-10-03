// Fixtures Sonar sets this while analysing on the fork path, where nothing may run the analysed code.
import { appendFileSync } from "node:fs";

if (process.env.SONAR_FORK_ANALYSIS_TRAP) {
  appendFileSync(
    process.env.SONAR_FORK_ANALYSIS_TRAP,
    `${import.meta.filename} ran\n`,
  );
  throw new Error("The fork path ran the analysed code");
}

export default {};
