// Para SDK is large (~640KB). Defer the import until first use so it does not
// land in chunks that don't actually invoke Para (e.g. EventPage / ClaimButton).
type ParaInstance = import("@getpara/web-sdk").default;

let _para: ParaInstance | null = null;
let _loading: Promise<ParaInstance> | null = null;

export async function getPara(): Promise<ParaInstance> {
  if (_para) return _para;
  if (_loading) return _loading;
  _loading = (async () => {
    const mod = await import("@getpara/web-sdk");
    _para = new mod.default(
      mod.Environment.BETA,
      import.meta.env.VITE_PARA_API_KEY as string,
    );
    return _para;
  })();
  return _loading;
}
