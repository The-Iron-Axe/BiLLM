function sameDeps(left, right) {
  return Boolean(left && right && left.length === right.length && left.every((item, i) => Object.is(item, right[i])));
}

/** Deterministic hook host for async lifecycle tests, with real dependency cleanup. */
function createHookHarness() {
  const slots = [];
  let index = 0;
  let dirty = false;
  let mounted = true;
  let hook;
  let props;
  let current;
  let pending = [];
  const react = {
    useState(initial) {
      const i = index++;
      if (!slots[i]) slots[i] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[i].value, (next) => {
        if (!mounted) throw new Error("State update after unmount");
        slots[i].value = typeof next === "function" ? next(slots[i].value) : next;
        dirty = true;
      }];
    },
    useRef(initial) {
      const i = index++;
      if (!slots[i]) slots[i] = { current: initial };
      return slots[i];
    },
    useCallback(callback, deps) {
      const i = index++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) slots[i] = { value: callback, deps };
      return slots[i].value;
    },
    useMemo(factory, deps) {
      const i = index++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) slots[i] = { value: factory(), deps };
      return slots[i].value;
    },
    useEffect(effect, deps) {
      const i = index++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) {
        pending.push(() => {
          slots[i]?.cleanup?.();
          slots[i] = { deps, cleanup: effect() };
        });
      }
    },
  };
  function flush() {
    let iterations = 0;
    do {
      dirty = false;
      index = 0;
      current = hook(props);
      const effects = pending;
      pending = [];
      effects.forEach((effect) => effect());
      if (++iterations > 50) throw new Error("Hook renders failed to settle");
    } while (dirty);
    return current;
  }
  return {
    react,
    mount(callback, initialProps) {
      hook = callback;
      props = initialProps;
      return flush();
    },
    render(nextProps = props) {
      props = nextProps;
      return flush();
    },
    get current() { return flush(); },
    unmount() {
      slots.forEach((slot) => slot?.cleanup?.());
      mounted = false;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

module.exports = { createHookHarness, deferred };
