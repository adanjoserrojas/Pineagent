import { DEV_TOOLS } from "../devtools";
import { Auth0Provider, useAuth0 } from "@auth0/auth0-react";
import { createContext, useContext, useMemo, type ReactNode } from "react";

export type Session = {
  displayName: string;
  getToken: () => Promise<string>;
  signIn: () => void; // a fresh sign-in, e.g. after the server rejected the token
  signOut: () => void;
};

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside AuthGate");
  return s;
}

const env = import.meta.env;
const auth0Configured = Boolean(env.VITE_AUTH0_DOMAIN && env.VITE_AUTH0_CLIENT_ID);

// Dev builds honour ?as=<name> even with Auth0 configured, so one person can test two users.
const devIdentityRequested = DEV_TOOLS && new URLSearchParams(window.location.search).has("as");

// Auth0 when configured; otherwise a dev identity from ?as=<name> that only the mock server accepts.
export function AuthGate({ children }: { children: ReactNode }) {
  if (!auth0Configured || devIdentityRequested) return <DevSession>{children}</DevSession>;
  return (
    <Auth0Provider
      domain={env.VITE_AUTH0_DOMAIN}
      clientId={env.VITE_AUTH0_CLIENT_ID}
      // Auth0 only redirects to registered URLs, so always come back to the origin and restore
      // the workspace path from appState.
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: env.VITE_AUTH0_AUDIENCE || undefined,
        connection: "github",
      }}
      onRedirectCallback={(appState) => {
        window.history.replaceState(null, "", appState?.returnTo ?? "/");
      }}
      // Refresh tokens survive reloads without third-party cookies. The localStorage cache is an
      // XSS exposure we accept for the hackathon; revisit before any real deployment.
      useRefreshTokens
      cacheLocation="localstorage"
    >
      <Auth0Session>{children}</Auth0Session>
    </Auth0Provider>
  );
}

function DevSession({ children }: { children: ReactNode }) {
  const name = new URLSearchParams(window.location.search).get("as") ?? "alice";
  const session = useMemo<Session>(
    () => ({ displayName: name, getToken: async () => `dev:${name}`, signIn: () => window.location.reload(), signOut: () => {} }),
    [name],
  );
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

function Auth0Session({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, error, user, loginWithRedirect, getAccessTokenSilently, getIdTokenClaims, logout } =
    useAuth0();
  const session = useMemo<Session | null>(
    () =>
      isAuthenticated
        ? {
            displayName: user?.nickname ?? user?.name ?? "you",
            getToken: async () => {
              // With an API audience the access token is a JWT the real server verifies. Without one,
              // Auth0 issues an opaque token, so dev falls back to the ID token (mock-only).
              const token = env.VITE_AUTH0_AUDIENCE
                ? await getAccessTokenSilently()
                : (await getAccessTokenSilently().then(() => getIdTokenClaims()))?.__raw;
              if (!token) throw new Error("Auth0 returned no token");
              return token;
            },
            signIn: () => loginWithRedirect({ appState: { returnTo: window.location.pathname + window.location.search } }),
            signOut: () => logout({ logoutParams: { returnTo: window.location.origin } }),
          }
        : null,
    [isAuthenticated, user, getAccessTokenSilently, getIdTokenClaims, loginWithRedirect, logout],
  );

  if (isLoading) return <p className="center-note">Signing in…</p>;
  if (!session) {
    const returnTo = window.location.pathname + window.location.search;
    return <SignIn error={error?.message} onSignIn={() => loginWithRedirect({ appState: { returnTo } })} />;
  };
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

function SignIn({ error, onSignIn }: { error?: string; onSignIn: () => void }) {
  return (
    <main className="signin">
      <h1>Pineagent</h1>
      <p>Sign in with GitHub to open a repository you collaborate on.</p>
      <button type="button" className="btn-primary" onClick={onSignIn}>
        Continue with GitHub
      </button>
      {error && <p role="alert" className="signin-error">{error}</p>}
    </main>
  );
}
