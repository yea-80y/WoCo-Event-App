import Para, { Environment } from "@getpara/web-sdk";

export const para = new Para(
  Environment.BETA,
  import.meta.env.VITE_PARA_API_KEY as string,
);
