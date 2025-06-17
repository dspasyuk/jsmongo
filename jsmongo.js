const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

class JSM {
    constructor(options = {}) {
        this.storageMode = options.storageMode || 'memory';
        this.storagePath = options.storagePath || path.join(process.cwd(), 'puredb');
        this._databases = {};
        this._collections = {};
        this._indexes = {};
        this._changedCollections = new Set();
        this._lastActivity = Date.now();
        this.idleTimeout = options.idleTimeout || (1 * 10 * 1000); // 30 sec default
        this._idleTimer = null;
        this._isShuttingDown = false;
        this._isDumping = false;
        this._isInitialized = false;
    }


    async createIndex(dbName, collectionName, field) {
        const fullCollectionName = `${dbName}.${collectionName}`;
        if (!this._indexes[fullCollectionName]) {
            this._indexes[fullCollectionName] = {};
        }
        const index = {};
        const collection = this._collections[fullCollectionName];
        if (!collection) return; //collection does not exist.
        for (let i = 0; i < collection.length; i++) {
            const doc = collection[i];
            const value = doc[field];
            if (!index[value]) {
                index[value] = [];
            }
            index[value].push(i);
        }
        this._indexes[fullCollectionName][field] = index;
    }

    async initialize() {
        try {
            await this._ensureStorageDirectory();
            await this._loadPersistedData();
            if (this.storageMode === 'disk') {
                this._startIdleDump();
            }
            this._setupSignalHandlers();
            
            // Check if any users exist, create admin if not
            await this._ensureAdminUser();
            
            this._isInitialized = true;
        } catch (err) {
            console.error('Error initializing database:', err);
            throw err;
        }
    }

    async _ensureAdminUser() {
        const fullCollectionName = 'auth.users';
        
        // Initialize auth.users collection if it doesn't exist
        if (!this._collections[fullCollectionName]) {
            this._collections[fullCollectionName] = [];
        }
        
        // Check if any users exist
        if (this._collections[fullCollectionName].length === 0) {
            // Create admin user with full permissions
            const adminPassword = await bcrypt.hash('admin', 10);
            const adminUser = {
                _id: this._generateUniqueId(),
                username: 'admin',
                password: adminPassword,
                roles: [
                    {
                        resource: '*', // Wildcard for all resources
                        permissions: ['read', 'write', 'admin']
                    }
                ]
            };
            
            this._collections[fullCollectionName].push(adminUser);
            this._changedCollections.add(fullCollectionName);
            
            console.log('Created default admin user (username: admin, password: admin)');
        }
    }

    async _ensureStorageDirectory() {
        try {
            await fs.mkdir(this.storagePath, { recursive: true });
        } catch (err) {
            if (err.code !== 'EEXIST') {
                throw new Error(`Failed to create storage directory: ${err.message}`);
            }
        }
    }

    async _loadPersistedData() {
        try {
            const dbFiles = await fs.readdir(this.storagePath);
            for (const file of dbFiles) {
                const fullPath = path.join(this.storagePath, file);
                const stat = await fs.stat(fullPath);
                if (stat.isDirectory()) {
                    const dbName = file;
                    this._databases[dbName] = true;
                    const collectionFiles = await fs.readdir(fullPath);
                    for (const collFile of collectionFiles) {
                        if (collFile.endsWith('.json')) {
                            const collectionName = path.basename(collFile, '.json');
                            const collectionPath = path.join(fullPath, collFile);
                            try {
                                const data = await fs.readFile(collectionPath, 'utf8');
                                this._collections[`${dbName}.${collectionName}`] = JSON.parse(data);
                            } catch (readErr) {
                                throw new Error(`Error reading collection ${collectionName}: ${readErr.message}`);
                            }
                        }
                    }
                }
            }
        } catch (err) {
            throw new Error(`Error loading persisted data: ${err.message}`);
        }
    }

    async _startIdleDump() {
        this._idleTimer = setInterval(async () => {
            if (Date.now() - this._lastActivity > this.idleTimeout && this._changedCollections.size > 0) {
                try {
                    await this._dumpChangedCollections();
                } catch (err) {
                    console.error('Error during idle data dump:', err);
                }
            }
        }, this.idleTimeout);
    }

    async _dumpChangedCollections() {
        for (const fullCollectionName of this._changedCollections) {
            const [dbName, collectionName] = fullCollectionName.split('.');
            const data = this._collections[fullCollectionName];
            await this._persistCollection(dbName, collectionName, data);
        }
        this._changedCollections.clear();
    }

    async _persistCollection(dbName, collectionName, data) {
        if (this.storageMode === 'disk') {
            const dbPath = path.join(this.storagePath, dbName);
            await fs.mkdir(dbPath, { recursive: true });
            const filePath = path.join(dbPath, `${collectionName}.json`);
            await fs.writeFile(filePath, JSON.stringify(data));
        }
    }

    db(dbName) {
        this._databases[dbName] = true;
        return {
            collection: (collectionName) => {
                const fullCollectionName = `${dbName}.${collectionName}`;
                if (!this._collections[fullCollectionName]) {
                    this._collections[fullCollectionName] = [];
                }
                return this._createCollectionMethods(dbName, collectionName);
            }
        };
    }

    _createCollectionMethods(dbName, collectionName) {
        const fullCollectionName = `${dbName}.${collectionName}`;
        const self = this;

        const updateActivity = () => {
            self._lastActivity = Date.now();
        };

        return {
            insertOne: async (doc, user) => {
                if (!user || self.checkPermission(user, fullCollectionName, 'write')) {
                    const collection = self._collections[fullCollectionName];
                    const newDoc = { ...doc, _id: self._generateUniqueId() };
                    collection.push(newDoc);
                    self._changedCollections.add(fullCollectionName);
                    if (self.storageMode === 'disk') {
                        updateActivity();
                    }
                    return newDoc;
                } else {
                    console.error(`Permission denied: User ${user?.username} does not have write access to this collection`);
                    return null;
                }
            },

            insertMany: async (docs, user) => {
                if (!user || self.checkPermission(user, fullCollectionName, 'write')) {
                    const collection = self._collections[fullCollectionName];
                    const newDocs = docs.map(doc => ({ ...doc, _id: self._generateUniqueId() }));
                    collection.push(...newDocs);
                    self._changedCollections.add(fullCollectionName);
                    if (self.storageMode === 'disk') {
                        updateActivity();
                    }
                    return newDocs;
                } else {
                    console.error(`Permission denied: User ${user?.username} does not have write access to this collection`);
                    return null;
                }
            },
           
            updateOne: async (filter, update, options = {}, user) => {
                // Permission Check
                if (!user || !self.checkPermission(user, fullCollectionName, 'write')) {
                    console.error(`Permission denied: User ${user?.username} does not have write access to this collection: ${fullCollectionName}`);
                    return { matchedCount: 0, modifiedCount: 0, acknowledged: false, error: 'Permission denied' };
                }
            
                const collection = self._collections[fullCollectionName];
                if (!collection) {
                    // console.warn(`updateOne called on non-existent collection: ${fullCollectionName}`);
                    return { matchedCount: 0, modifiedCount: 0, acknowledged: true };
                }
            
                const upsert = options?.upsert === true;
                console.log('Upsert option:', upsert); // Debug log
            
                let matchedIndex = -1;
            
                // Match phase
                for (let i = 0; i < collection.length; i++) {
                    if (self._matchQuery(collection[i], filter)) {
                        matchedIndex = i;
                        // console.log('Found matching document at index:', i, collection[i]);
                        break;
                    }
                }
            
                if (matchedIndex !== -1) {
                    // Update existing document
                    const docToUpdate = collection[matchedIndex];
                    const originalId = docToUpdate._id;
            
                    if (update.$set) {
                        const setData = { ...update.$set };
                        delete setData._id;
                        Object.assign(docToUpdate, setData);
                    } else {
                        const replacementData = { ...update };
                        delete replacementData._id;
                        for (const key of Object.keys(docToUpdate)) {
                            if (key !== '_id') delete docToUpdate[key];
                        }
                        Object.assign(docToUpdate, replacementData);
                    }
            
                    docToUpdate._id = originalId;
                    self._changedCollections.add(fullCollectionName);
                    if (self.storageMode === 'disk') updateActivity();
            
                    // console.log('Document updated successfully');
                    return { matchedCount: 1, modifiedCount: 1, acknowledged: true };
                }

                // No match found → handle upsert
                if (upsert) {
                    // console.log('No match found, performing upsert');
            
                    const newDocData = { ...filter };
                    if (update.$set) {
                        Object.assign(newDocData, update.$set);
                    } else {
                        Object.assign(newDocData, update);
                    }
            
                    delete newDocData._id;
            
                    const newDoc = {
                        ...newDocData,
                        _id: self._generateUniqueId()
                    };
            
                    // console.log('Inserting new document:', newDoc);
                    collection.push(newDoc);
                    self._changedCollections.add(fullCollectionName);
                    if (self.storageMode === 'disk') updateActivity();
            
                    // console.log('Upsert completed successfully');
                    return {
                        matchedCount: 0,
                        modifiedCount: 1,
                        upsertedId: newDoc._id,
                        acknowledged: true,
                        upserted: true
                    };
                }
            
                console.log('No match found, no upsert requested');
                return { matchedCount: 0, modifiedCount: 0, acknowledged: true };
            },

            deleteOne: async (filter, user) => {
                if (!user || self.checkPermission(user, fullCollectionName, 'write')) {
                    const collection = self._collections[fullCollectionName];
                    let deletedCount = 0;
                    for (let i = 0; i < collection.length; i++) {
                        if (self._matchQuery(collection[i], filter)) {
                            collection.splice(i, 1);
                            self._changedCollections.add(fullCollectionName);
                            deletedCount++;
                            i--; // Adjust index after splice
                        }
                    }
                    if (self.storageMode === 'disk') {
                        updateActivity();
                    }
                    return deletedCount;
                } else {
                    console.error(`Permission denied: User ${user?.username} does not have write access to this collection`);
                    return 0;
                }
            },

            find: (query = {}, user) => {
                if (!user || self.checkPermission(user, fullCollectionName, 'read')) {
                    const collection = self._collections[fullCollectionName];
                    if (!collection) return []; //collection does not exist.
                    const results = [];
                    const indexKeys = Object.keys(query);
                    if (indexKeys.length === 1 && self._indexes[fullCollectionName] && self._indexes[fullCollectionName][indexKeys[0]]) {
                        const index = self._indexes[fullCollectionName][indexKeys[0]];
                        const value = query[indexKeys[0]];
                        if (index[value]) {
                            for (const indexValue of index[value]) {
                                results.push(collection[indexValue]);
                            }
                            return results;
                        } else {
                            return [];
                        }
                    }

                    for (let i = 0; i < collection.length; i++) {
                        if (self._matchQuery(collection[i], query)) {
                            results.push(collection[i]);
                        }
                    }
                    return results;
                } else {
                    console.error(`Permission denied: User ${user?.username} does not have read access to this collection`);
                    return [];
                }
            },
            
            createIndex: async (field, user) => {
                if (!user || self.checkPermission(user, fullCollectionName, 'write')) {
                    await self.createIndex(dbName, collectionName, field);
                    return true;
                } else {
                    console.error(`Permission denied: User ${user?.username} does not have write access to this collection`);
                    return false;
                }
            },
        };
    }

    _generateUniqueId() {
        const timestamp = Math.floor(Date.now() / 1000);
        const hexTimestamp = timestamp.toString(16).padStart(8, '0');
        const randomId = crypto.randomBytes(12).toString('hex');
        const objectId = `${hexTimestamp}${randomId}`;
        return objectId;
    }

    _matchQuery(doc, query) {
        for (const [key, value] of Object.entries(query)) {
            if (typeof value === 'object' && value !== null) {
                for (const [operator, compValue] of Object.entries(value)) {
                    switch (operator) {
                        case '$gt':
                            if (!(doc[key] > compValue)) return false;
                            break;
                        case '$lt':
                            if (!(doc[key] < compValue)) return false;
                            break;
                        case '$gte':
                            if (!(doc[key] >= compValue)) return false;
                            break;
                        case '$lte':
                            if (!(doc[key] <= compValue)) return false;
                            break;
                        case '$eq':
                            if (!(doc[key] === compValue)) return false;
                            break;
                        case '$ne':
                            if (!(doc[key] !== compValue)) return false;
                            break;
                        case '$in':
                            if (!Array.isArray(compValue) || !compValue.includes(doc[key])) return false;
                            break;
                        case '$nin':
                            if (!Array.isArray(compValue) || compValue.includes(doc[key])) return false;
                            break;
                        default:
                            return false;
                    }
                }
            } else if (doc[key] !== value) {
                return false;
            }
        }
        return true;
    }

    async loginUser(username, password) {
        const users = this.db('auth').collection('users').find({ username });
        if (users.length === 0) return null;
        const user = users[0];
        const isMatch = await bcrypt.compare(password, user.password);
        return isMatch ? user : null;
    }

    async registerUser(username, password, roles = []) {
        // Check if user already exists
        const existingUsers = this.db('auth').collection('users').find({ username });
        if (existingUsers.length > 0) {
            throw new Error(`User ${username} already exists`);
        }
        
        // If no roles provided, set default read-only role
        if (!roles || roles.length === 0) {
            roles = [
                {
                    resource: '*',
                    permissions: ['read']
                }
            ];
        }
        
        const hash = await bcrypt.hash(password, 10);
        return await this.db('auth').collection('users').insertOne({
            username,
            password: hash,
            roles: roles
        });
    }

    hasPermission(user, resource, permission) {
        if (!user || !user.roles) return false;
        
        // Admin role has all permissions
        if (user.roles.some(role => 
            (role.resource === '*' && role.permissions.includes('admin')))) {
            return true;
        }
        
        return user.roles.some(role => {
            // Exact resource match or database-level match or wildcard
            if (role.resource === resource || 
                role.resource === resource.split('.')[0] || 
                role.resource === '*') {
                return role.permissions.includes(permission);
            }
            return false;
        });
    }

    checkPermission(user, resource, permission) {
        if (!this.hasPermission(user, resource, permission)) {
            return false; // Return false for denied permission
        }
        return true; // Return true for granted permission
    }
    
    async close() {
        if (this._idleTimer) {
            clearInterval(this._idleTimer);
        }
        await this._dumpAllData();
        this._databases = {};
        this._collections = {};
        this._indexes = {};
    }

    async _dumpAllData() {
        console.log('Dumping all database data to disk...');
        if (this._isDumping) return;
        this._isDumping = true;
        try {
            await this._dumpChangedCollections(); // Dump changed collections first
            for (const dbName in this._databases) {
                const collections = Object.keys(this._collections)
                    .filter(key => key.startsWith(`${dbName}.`));
                for (const fullCollectionName of collections) {
                    const collectionName = fullCollectionName.split('.').pop();
                    const data = this._collections[fullCollectionName];
                    await this._persistCollection(dbName, collectionName, data);
                }
            }
        } finally {
            this._isDumping = false;
        }
    }

    _setupSignalHandlers() {
        const signals = ['SIGINT', 'SIGTERM'];
        signals.forEach(signal => {
            process.on(signal, async () => {
                if (this._isShuttingDown) return;
                this._isShuttingDown = true;
                try {
                    console.log(`\nReceived ${signal}. Performing graceful shutdown...`);
                    if (this._idleTimer) {
                        clearInterval(this._idleTimer);
                    }
                    if (this.storageMode === 'disk') {
                        await this._dumpAllData();
                    }
                    console.log('Database data saved successfully.');
                } catch (err) {
                    console.error('Error during database shutdown:', err);
                } finally {
                    process.exit(0);
                }
            });
        });
    }
}

// Create a function that wraps our JSM class and makes instances callable
function createJSM(options) {
    const dbInstance = new JSM(options);
    
    // Create a callable function that proxies to db.db()
    const dbProxy = function(dbName) {
        return dbInstance.db(dbName);
    };
    
    // Copy all properties and methods from the instance to the proxy
    Object.setPrototypeOf(dbProxy, dbInstance);
    
    // Copy all properties from JSM.prototype to the proxy's prototype
    for (const prop of Object.getOwnPropertyNames(JSM.prototype)) {
        if (prop !== 'constructor') {
            dbProxy[prop] = dbInstance[prop].bind(dbInstance);
        }
    }
    
    return dbProxy;
}

// Export a function that creates our enhanced DB instances
module.exports = function(options) {
    return createJSM(options);
};