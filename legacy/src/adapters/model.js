// "Load model's interaction": any coding model/agent plugs in through this shape.
// The system RECORDS the model (modelId goes into every mark) but does not judge it.

/**
 * @typedef {Object} Submission
 * @property {string} diff          unified diff proposed by the model
 * @property {number} linesChanged  checked on-chain against APPROVE_DEPTH
 */

export class ModelProvider {
  /** @returns {string} stable identifier, e.g. "vendor/model@version" */
  get modelId() { throw new Error('not implemented'); }
  /** @returns {Promise<Submission>} */
  async submit(/* { input, context } */) { throw new Error('not implemented'); }
}

/** Deterministic stand-in so the flow can run offline. Replace with a real agent adapter. */
export class MockModel extends ModelProvider {
  constructor(id = 'mock/coder@2026-09') { super(); this._id = id; }
  get modelId() { return this._id; }

  async submit({ input, context }) {
    const lines = [
      `--- a/${context.target}`,
      `+++ b/${context.target}`,
      `@@ round ${context.round} @@`,
      `+// task: ${input}`,
      ...context.feedback.map((f) => `+// addressed: ${f}`),
      '+export function handler(x) {',
      '+  if (x == null) throw new TypeError("x required");',
      '+  return x;',
      '+}',
    ];
    return { diff: lines.join('\n'), linesChanged: lines.length - 3 };
  }
}
