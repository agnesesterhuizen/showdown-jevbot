const DEFAULT_LOGIN_ENDPOINT = "https://play.pokemonshowdown.com/api/login";

/** Get a Pokémon Showdown login assertion. */
export async function getLoginAssertion({
  username,
  password,
  challstr,
  endpoint = DEFAULT_LOGIN_ENDPOINT,
  fetchImpl = globalThis.fetch,
}: {
  username: string;
  password: string;
  challstr: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}) {
  if (!username || !password || !challstr) {
    throw new Error("Missing username, password, or server challenge.");
  }
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    body: new URLSearchParams({ name: username, pass: password, challstr }),
  });
  if (!response.ok) {
    throw new Error(`Login endpoint returned HTTP ${response.status}.`);
  }
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw.startsWith("]") ? raw.slice(1) : raw);
  } catch {
    throw new Error("Login endpoint returned an invalid response.");
  }
  if (!data.assertion || data.assertion.startsWith(";;")) {
    throw new Error(
      "Login was rejected; check the account credentials and server challenge.",
    );
  }
  return data.assertion;
}

export function redactProtocolMessage(message: string): string {
  return message.replace(/(\|\/trn [^,]+,[^,]*,).+$/, "$1[assertion redacted]");
}
