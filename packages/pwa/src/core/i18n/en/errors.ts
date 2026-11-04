export const errors = {
  media: {
    forbidden: "Couldn't load this file: the agent may not read it.",
    'not-found': "Couldn't load this file: it was not found.",
    error: "Couldn't load this file: the agent could not read it.",
  },
  mediaFailed: "Couldn't load this file.",
  fileTooLarge: (maxMb: number) => `File is too large to attach (${maxMb} MB max)`,
};
