import type { Messages } from '../en';

export const keyboard: Messages['keyboard'] = {
  toolbar: 'Touches du terminal',
  control: 'Contrôle',
  option: 'Option',
  command: 'Commande',
  dictate: (preset) => `Dicter (${preset})`,
  cursorPad: 'Pavé de curseur',
  selectText: 'Sélectionner du texte',
  paste: 'Coller',
  attachFile: 'Joindre un fichier',
};
