// Context handling between rounds. On every deny the context is REBUILT from the base
// (task + target + accumulated reviewer feedback) instead of appending to an ever-growing
// transcript, so each round starts fresh. The hash of what the reviewer was shown goes
// into the mark (contextHash): later, anyone can check what the approver actually saw.
import { keccak256, toUtf8Bytes } from 'ethers';

export class SessionContext {
  constructor({ sessionId, repo, target, task }) {
    this.sessionId = sessionId;
    this.repo = repo;
    this.target = target;
    this.task = task;
    this.feedback = []; // one entry per deny
    this.history = []; //  off-chain log of every round
  }

  /** Fresh context for the next model call. */
  restore() {
    return {
      repo: this.repo,
      target: this.target,
      task: this.task,
      feedback: [...this.feedback],
      round: this.feedback.length + 1,
    };
  }

  deny(newInput, submission) {
    this.history.push({ round: this.feedback.length + 1, decision: 'deny', newInput, diffHash: hashText(submission.diff) });
    this.feedback.push(newInput);
  }

  accept(submission) {
    this.history.push({ round: this.feedback.length + 1, decision: 'accept', diffHash: hashText(submission.diff) });
  }

  /** What the reviewer was shown: context + diff. */
  contextHash(ctx, submission) {
    return hashText(JSON.stringify({ ctx, diff: submission.diff }));
  }
}

export const hashText = (s) => keccak256(toUtf8Bytes(s));
