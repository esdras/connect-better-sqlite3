# Connect - SQLite3

Implementation of a Session Store using SQLite. This library
should be used in conjunction with the express-session library.
This implementation uses better-sqlite3 to connect to SQLite.

All queries used by this library are compiled during initialization
using the db.prepare() function.

Because SQLite is used, all data is stored in a file in the host of
the node process. This means that the data saved in one host will not
be available to others, unless you replicate the data yourself.

## Usage

```javascript
const session = require("express-session");
const SQLiteStore = require("connect-better-sqlite3")(session);

const store = new SQLiteStore();

app.use(session({ store }));
```
