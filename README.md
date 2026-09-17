# Sillon

Lecteur de musique personnel, installable sur téléphone (PWA) : tes fichiers audio et tes playlists Deezer ou Spotify, sans pub.

- Import de fichiers audio (MP3, M4A, FLAC, WAV, OGG), stockés sur l'appareil
- Import de playlists Deezer (lien de playlist, d'album ou de profil public) et Spotify (connexion)
- Lecture complète via tes fichiers ou Spotify Premium
- Compte en ligne : bibliothèque, titres likés et fichiers audio synchronisés entre appareils

## Lancer en local

```sh
python3 -m http.server 8000
```

Puis ouvrir http://127.0.0.1:8000.

## Mettre en ligne

Site statique sans étape de build, hébergé sur Vercel : chaque push sur `main` redéploie le site.

## Comptes (Supabase)

Les comptes et la sauvegarde en ligne utilisent [Supabase](https://supabase.com), gratuit sans carte bancaire.

1. Crée un compte sur supabase.com puis un **New project** (région conseillée : Europe, Paris).
2. **SQL Editor** > **New query** : colle le contenu de `supabase/setup.sql` puis **Run**.
3. **Authentication** > **URL Configuration** : mets l'adresse du site Vercel (par exemple `https://sillon.vercel.app/`) dans **Site URL** et ajoute-la aussi dans **Redirect URLs**.
4. Facultatif : **Authentication** > **Sign In / Providers** > **Email**, désactive **Confirm email** pour ne pas avoir à valider l'adresse par e-mail.
5. **Project Settings** > **API Keys** : copie la **Project URL** et la clé **publishable** (ou **anon**) dans `js/config.js`.

La clé publishable peut être publique : les règles de `setup.sql` empêchent chaque compte d'accéder aux données des autres.

Limites du plan gratuit : 1 Go de fichiers, 50 Mo par fichier, 5 Go de téléchargement par mois. Un projet inactif pendant 7 jours est mis en pause (il se relance depuis le tableau de bord Supabase). Chaque fichier n'est téléchargé qu'une fois par appareil, puis lu hors ligne.
