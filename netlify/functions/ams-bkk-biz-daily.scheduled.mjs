export const config = {
  schedule: "0 12 * * *" // daily at 12:00 UTC
};

// Re-use the SAME handler
export { handler } from "./ams-bkk-biz-daily.mjs";
