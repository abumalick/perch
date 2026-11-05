import type { Messages } from '../en';

export const pairing: Messages['pairing'] = {
  otherKey: (machine) =>
    `Ce code indique pour ${machine} une autre clé que celle à laquelle ce téléphone fait confiance. Si l’identité de la machine a changé, supprimez d’abord cette entrée.`,
  question: (machine, host, fingerprint) =>
    `Associer ${machine} via ${host} ?\n\n` +
    `Clé de la machine ${fingerprint} : vérifiez qu’elle correspond à ce qu’a affiché perch pair.\n\n` +
    'Ne continuez que si vous venez de lancer perch pair sur cette machine.',
  notALink: "Ce n’est pas un code d’association Tarfa. Lancez `perch pair` sur la machine pour en obtenir un nouveau.",
  otherOrigin: (origin, own) => `Ce code d’association est pour le Tarfa de ${origin}, pas pour celui-ci (${own}).`,
  cameraRefused: "L’accès à la caméra a été refusé. Autorisez-le pour cette application, ou collez le lien d’association ci-dessous.",
  cameraFailed: (error) => `Impossible d’ouvrir la caméra (${error}). Collez plutôt le lien d’association ci-dessous.`,
  clipboardFailed: 'Impossible de lire le presse-papiers. Collez-le plutôt dans le champ ci-dessous.',
  cancel: 'Annuler',
  scan: 'Scanner le QR code',
  pasteLink: "Coller le lien d’association",
  orPaste: "Ou collez un lien d’association",
  pair: 'Associer',
  hintBefore: 'Lancez ',
  hintAfter: ' sur la machine pour obtenir un code. Il sert une fois, pendant 10 minutes ou la durée donnée par --ttl.',
};
