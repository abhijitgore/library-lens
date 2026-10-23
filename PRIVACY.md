# Library Lens privacy policy

Effective 22 October 2026. Applies to Library Lens version 0.11.23 and later.

Library Lens is a Chrome extension that checks whether a book you are viewing on Amazon, Barnes & Noble, or Goodreads is available at the public library catalogs you select. It is an independent project. It is not affiliated with, endorsed by, or sponsored by any library, Amazon, Barnes & Noble, or Goodreads.

## What the extension reads

- **The book page you are viewing.** When you click the Library Lens icon on a supported book page, the extension reads that page once to find the book's title, author, ISBN, publisher, publication date, language, edition, and cover image address. It does not read any page until you click, and it does not read pages on other websites.
- **Nothing else from your browser.** The extension does not read your browsing history, bookmarks, cookies, passwords, or other tabs. It has no analytics and no remote AI service.

## What leaves your device, and where it goes

- **Your selected library catalogs** receive the book title, author, and ISBN as a search. These requests omit cookies and the address of the page you came from. Searching a catalog can reveal reading interests to that library.
- **The Library of Congress (lx2.loc.gov)** can receive the ISBN to verify book details read from Goodreads.
- **Amazon and Barnes & Noble image servers** receive a request for the book's cover image, without a referrer and without cookies. The image server still receives your network address.

No data is sent to the developer or to any other party.

## What stays on your device

- **Your ZIP code** is used in Settings to rank nearby supported libraries. It is processed on your device only. It is not stored and not sent anywhere.
- **Your selected libraries and preferred reading format** are saved in local extension storage.
- **Book details, catalog results, and one prepared purchase request** are kept in temporary browser-session storage. Results are reused for ten minutes. The prepared request becomes invalid after one hour. Reloading the extension or restarting the browser clears this data.

## Library accounts and request forms

Library Lens does not collect or store library usernames, card numbers, or passwords. It does not sign in for you or check your account details. You place holds and submit purchase requests on the official library website. For King County Library System and The Seattle Public Library, a Fill details control can enter the book's bibliographic fields into the official request form when you choose it. It never fills login, contact, or payment fields, and it never submits the form.

## Permissions

The extension uses the `activeTab`, `scripting`, and `storage` permissions, plus host permissions for the supported library catalogs, the Library of Congress verification endpoint, and the two library request-form pages. It loads no remote code.

## Limited Use

Library Lens's use of information received from Chrome APIs adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use), including the Limited Use requirements. Data is used only to provide the extension's single purpose: checking a book at your selected libraries.

## Changes and contact

Changes to this policy are published in the Library Lens source repository with the version they apply to. Questions can be raised as an issue in that repository.
