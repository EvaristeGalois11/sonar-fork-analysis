// Deliberate issue for Sonar to find: a dead store.
function triple(n) {
  const unused = n * 2;
  return n * 3;
}

module.exports = { triple };
