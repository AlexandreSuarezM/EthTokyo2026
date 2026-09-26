/** EIP-712 types shared by the server and the browser (public; the wallet signs HumanApproval). */
export const APPROVAL_TYPES = {
  HumanApproval: [
    { name: "sessionId", type: "bytes32" },
    { name: "repoId", type: "bytes32" },
    { name: "commitHash", type: "bytes32" },
    { name: "contextHash", type: "bytes32" },
    { name: "modelId", type: "bytes32" },
    { name: "submitter", type: "address" },
    { name: "linesChanged", type: "uint32" },
    { name: "rounds", type: "uint16" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
