// Server-side building blocks (Node only). The browser imports ./contracts and ./ops, never this.
export { auth0Verifier, type Auth0Options, type User } from "./auth0";
export { createGateway, type GatewayOptions, type JoinContext, type Room, type PtySession } from "./gateway";
export { GitError, GitRepo, tokenEnv, type GitStatusEntry } from "./git";
export { ChangeFeed } from "./gitChanges";
export { GitQueue, type Author, type QueueEvents } from "./gitQueue";
export { noHarness, type Harness, type HarnessContext, type HarnessEvents, type HarnessFactory } from "./harness";
export { MemoryStore, type RoomSnapshot, type RoomStore, type Store, type StoredFile, type StoredLock } from "./store";
export { MAX_FILE_BYTES, MAX_IMAGE_BYTES, Workspace, publicLock, type Persistence, type ReadResult, type Timing } from "./workspace";
