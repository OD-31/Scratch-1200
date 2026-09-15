# Skratch 1200 — platine de scratch pour iPad

Web app installable (PWA), en mode portrait, sans dépendance.

## Lancer en local (sur le Mac)

```bash
npm start
```

Puis ouvrir http://localhost:3000 dans Chrome ou Safari.

## Mettre en ligne avec Railway

1. Mettre ce dossier dans un dépôt GitHub (ou utiliser la CLI : `railway up` depuis ce dossier).
2. Sur railway.com : **New Project → Deploy from GitHub repo** → choisir le dépôt.
3. Railway détecte Node et lance `npm start` tout seul (le port est fourni automatiquement).
4. Dans **Settings → Networking → Generate Domain** pour obtenir une adresse `https://…up.railway.app`.

## Installer sur l'iPad

1. Ouvrir l'adresse Railway dans **Safari**.
2. Bouton **Partager** → **Sur l'écran d'accueil**.
3. L'app s'ouvre en plein écran comme une vraie app, et marche aussi hors ligne.

> Pas de son ? Désactive le mode silencieux de l'iPad (Web Audio le respecte).

## Utilisation

| Zone | Rôle |
|---|---|
| 📂 Charger | Ouvre l'app Fichiers pour choisir un sample (wav, mp3, m4a, aiff…) |
| Bibliothèque | Samples déjà chargés, avec leurs découpes et leur BPM |
| BPM − / + / TAP | Tempo du morceau (toucher le chiffre pour le saisir) |
| Onde du haut | Défile avec la tête de lecture ; glisser dessus = scratcher |
| Onde du bas | Vue d'ensemble : toucher = se placer ; en **CHOP** toucher = poser un point |
| Points de découpe | Glisser pour déplacer, appui long pour supprimer (6 max) |
| Sample xx bpm / Détecter | BPM d'origine du sample (auto-détecté, modifiable en le touchant) |
| TIME STRETCH | Cale le sample sur le BPM sans changer la tonalité |
| Pads 1–6 | Sautent au point de découpe. Allumé plein = segment en cours, couleur douce = prêt, clignotant = en attente, éteint = pas de point |
| LOOP PAD | Boucle sur le segment du pad en cours |
| SON / MUTE | Gros bouton fader : vert = son ouvert, rouge = coupé |
| Platine | Poser le doigt = attraper le disque ; tourner = avancer / reculer |
| PLAY / REVERSE / STOP | STOP ralentit progressivement comme une coupure de courant (durée réglable dans ⚙︎) |
| PITCH / 33 / 45 / SYNC | Vitesse du moteur ; SYNC cale la vitesse sur le BPM (change la tonalité) |

Au centre de la platine, l'onde du sample est enroulée en spirale (un tour = 1,8 s de son, comme un 33 tours) ; le repère rouge fixe indique la tête de lecture.
