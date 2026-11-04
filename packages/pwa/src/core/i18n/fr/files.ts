import type { Messages } from '../en';

export const files: Messages['files'] = {
  back: 'Retour',
  pickFolder: 'Choisir un dossier',
  cancel: 'Annuler',
  close: 'Fermer',
  openFolderError: 'Impossible d’ouvrir ce dossier.',
  loading: 'Chargement…',
  upOneLevel: 'Dossier parent',
  folderName: 'Nom du dossier',
  create: 'Créer',
  alreadyExists: (name: string) => `« ${name} » existe déjà ici.`,
  newFolder: 'Nouveau dossier…',
  useFolder: 'Utiliser ce dossier',
};
