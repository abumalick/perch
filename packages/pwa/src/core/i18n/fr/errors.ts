import type { Messages } from '../en';

export const errors: Messages['errors'] = {
  media: {
    forbidden: 'Impossible de charger ce fichier : l’agent n’a pas le droit de le lire.',
    'not-found': 'Impossible de charger ce fichier : il est introuvable.',
    error: 'Impossible de charger ce fichier : l’agent n’a pas pu le lire.',
  },
  mediaFailed: 'Impossible de charger ce fichier.',
  fileTooLarge: (maxMb) => `Fichier trop volumineux pour être joint (${maxMb} Mo max)`,
};
