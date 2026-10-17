import { test } from "@playwright/test";

// Tests that share the default mock run in parallel, so each one gets its own workspace room
// (/ws/<test id>/main). Pages within one test share it.
export const home = (name: string) => `/ws/${test.info().testId}/main?as=${name}`;
