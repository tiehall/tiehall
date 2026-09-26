// The app's database handle, which the server opens as the app role and
// execute() hands to withOrg(). Only packages/commands and the migrations may
// import packages/db (design.md, Technical decisions: T2).
export { openDatabase, type Database } from "@tiehall/db";
