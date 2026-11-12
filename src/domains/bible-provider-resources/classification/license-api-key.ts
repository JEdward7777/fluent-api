/** Read the configured provider key at the point of use, after any CLI dotenv load. */
export function licenseApiKey(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.GOOGLE_AI_API_KEY?.trim() ?? '';
}
