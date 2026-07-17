interface ClientConfig {
    /** e.g. Joe Previte */
    fullName: string
    language: 'en' | 'es'
}

export const CLIENT_CONFIG: Record<string, ClientConfig> = {
    "Tim": {
        fullName: "Tim Gailey",
        language: "en",
    },
};