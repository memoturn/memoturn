/**
 * Static regex-safety checks, shared by the PII-masking policy (packages/server) and the code
 * evaluator's `matches()` builtin (packages/core). Lives here because core is the lowest common
 * dependency — duplicating a ReDoS heuristic is how one copy quietly stops matching the other.
 */

export function isValidRegex(src: string): boolean {
  try {
    return Boolean(new RegExp(src, "g"));
  } catch {
    return false;
  }
}

/**
 * Maximum regex "star height": the deepest nesting of repetition operators (`*`, `+`, `{n,}`).
 * A height ≥ 2 — a repeated group that itself repeats, e.g. `(a+)+` or `([a-z]*)*` — is the
 * structural signature of catastrophic backtracking (ReDoS). This is computed by walking the
 * pattern STATICALLY (no execution), so it is deterministic and portable — unlike timing a probe
 * input, which varies with CPU speed and, on a pathological pattern, can itself hang the caller.
 * Conservative by design: it may reject an unusual-but-safe nested-repeat pattern, which is an
 * acceptable trade for a PII-redaction config that runs on every event in the shared worker.
 */
export function maxStarHeight(src: string): number {
  let i = 0;

  const walk = (): number => {
    let groupMax = 0;
    let lastHeight = 0; // star height of the most recent atom at this level
    let haveAtom = false;
    const bump = (h: number) => {
      if (h > groupMax) groupMax = h;
    };
    const flushAtom = () => {
      if (haveAtom) bump(lastHeight);
    };

    while (i < src.length) {
      const c = src[i];
      if (c === ")") break; // let the caller consume the ')'
      if (c === "|") {
        flushAtom();
        lastHeight = 0;
        haveAtom = false;
        i++;
      } else if (c === "\\") {
        flushAtom();
        lastHeight = 0;
        haveAtom = true;
        i += 2; // escaped atom
      } else if (c === "[") {
        flushAtom();
        i++;
        while (i < src.length && src[i] !== "]") {
          if (src[i] === "\\") i++;
          i++;
        }
        i++; // closing ]
        lastHeight = 0;
        haveAtom = true;
      } else if (c === "(") {
        flushAtom();
        i++;
        // Skip a group-type prefix so its punctuation isn't misread as a quantifier.
        if (src[i] === "?") {
          i++;
          if (src[i] === "<" && (src[i + 1] === "=" || src[i + 1] === "!"))
            i += 2; // lookbehind
          else if (src[i] === "<") {
            while (i < src.length && src[i] !== ">") i++;
            if (src[i] === ">") i++; // named group
          } else if (src[i] === ":" || src[i] === "=" || src[i] === "!") i++;
        }
        lastHeight = walk();
        if (src[i] === ")") i++;
        haveAtom = true;
      } else if (c === "*" || c === "+") {
        if (haveAtom) bump((lastHeight += 1));
        i++;
      } else if (c === "{") {
        const close = src.indexOf("}", i);
        if (close === -1) {
          flushAtom(); // a literal '{'
          lastHeight = 0;
          haveAtom = true;
          i++;
        } else {
          const repeating = src.slice(i + 1, close).includes(","); // {n,}/{n,m} repeat; {n} is exact
          i = close + 1;
          if (haveAtom && repeating) bump((lastHeight += 1));
        }
      } else if (c === "?") {
        i++; // optional / lazy suffix — adds no star height
      } else {
        flushAtom(); // ordinary literal
        lastHeight = 0;
        haveAtom = true;
        i++;
      }
    }
    flushAtom();
    return groupMax;
  };

  return walk();
}
