function makeRunner(step = 2) {
  let total = 0;

  return function run(values) {
    const events = [];

    for (const value of values) {
      total += value * step;
      events.push(total);
    }

    return { total, events };
  };
}

class Box {
  constructor(value) {
    this.value = value;
  }

  read() {
    return this.value;
  }
}

const runner = makeRunner();

console.log(
  JSON.stringify({
    first: runner([1, 2]),
    second: runner([3]),
    boxed: new Box(17).read(),
    text: "snow 雪 🚀",
    marker: "//# sourceMappingURL=inside-a-string",
  }),
);

//# sourceMappingURL=sample.mjs.map
