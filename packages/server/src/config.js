export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://rebendei:rebendei@localhost:54329/rebendei",
  port: Number(process.env.PORT ?? 3210),
};
