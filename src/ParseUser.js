/**
 * Copyright (c) 2015-present, Parse, LLC.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 */

import CoreManager from './CoreManager';
import isRevocableSession from './isRevocableSession';
import * as ObjectState from './ObjectState';
import ParseError from './ParseError';
import ParseObject from './ParseObject';
import ParsePromise from './ParsePromise';
import ParseSession from './ParseSession';
import Storage from './Storage';

import * as Store from './ReduxStore';
import { UserActions as Actions } from './ReduxActionCreators';

import type { AttributeMap } from './ObjectState';
import type { RequestOptions, FullOptions } from './RESTController';

export type AuthData = ?{ [key: string]: mixed };

var CURRENT_USER_KEY = 'currentUser';
var canUseCurrentUser = !CoreManager.get('IS_NODE');
var currentUserCacheMatchesDisk = false;

var currentUserCache = (function() {
	var _currentUserCache = null;

	return {
		get() {
			return _currentUserCache;
		},
		set(user) {
			Store.dispatch(Actions.set(user));
			_currentUserCache = user;
		}
	}
})();

var authProviders = {};

/**
 * @class Parse.User
 * @constructor
 *
 * <p>A Parse.User object is a local representation of a user persisted to the
 * Parse cloud. This class is a subclass of a Parse.Object, and retains the
 * same functionality of a Parse.Object, but also extends it with various
 * user specific methods, like authentication, signing up, and validation of
 * uniqueness.</p>
 */
export default class ParseUser extends ParseObject {
  constructor(attributes: ?AttributeMap) {
    super('_User');
    if (attributes && typeof attributes === 'object'){
      if (!this.set(attributes || {})) {
        throw new Error('Can\'t create an invalid Parse User');
      }
    }
  }

  /**
   * Request a revocable session token to replace the older style of token.
   * @method _upgradeToRevocableSession
   * @param {Object} options A Backbone-style options object.
   * @return {Parse.Promise} A promise that is resolved when the replacement
   *   token has been fetched.
   */
  _upgradeToRevocableSession(options: RequestOptions) {
    options = options || {};

    var upgradeOptions = {};
    if (options.hasOwnProperty('useMasterKey')) {
      upgradeOptions.useMasterKey = options.useMasterKey;
    }

    var controller = CoreManager.getUserController();
    return controller.upgradeToRevocableSession(
      this,
      upgradeOptions
    )._thenRunCallbacks(options);
  }

  /**
   * Unlike in the Android/iOS SDKs, logInWith is unnecessary, since you can
   * call linkWith on the user (even if it doesn't exist yet on the server).
   * @method _linkWith
   */
  _linkWith(provider, options: { authData?: AuthData }): ParsePromise {
    var authType;
    if (typeof provider === 'string') {
      authType = provider;
      provider = authProviders[provider];
    } else {
      authType = provider.getAuthType();
    }
    if (options && options.hasOwnProperty('authData')) {
      var authData = this.get('authData') || {};
      authData[authType] = options.authData;

      var controller = CoreManager.getUserController();
      return controller.linkWith(
        this,
        authData
      )._thenRunCallbacks(options, this);
    } else {
      var promise = new ParsePromise();
      provider.authenticate({
        success: (provider, result) => {
          var opts = {};
          opts.authData = result;
          if (options.success) {
            opts.success = options.success;
          }
          if (options.error) {
            opts.error = options.error;
          }
          this._linkWith(provider, opts).then(() => {
            promise.resolve(this);
          }, (error) => {
            promise.reject(error);
          });
        },
        error: (provider, error) => {
          if (options.error) {
            options.error(this, error);
          }
          promise.reject(error);
        }
      });
      return promise;
    }
  }

  /**
   * Synchronizes auth data for a provider (e.g. puts the access token in the
   * right place to be used by the Facebook SDK).
   * @method _synchronizeAuthData
   */
  _synchronizeAuthData(provider: string) {
    if (!this.isCurrent() || !provider) {
      return;
    }
    var authType;
    if (typeof provider === 'string') {
      authType = provider;
      provider = authProviders[authType];
    } else {
      authType = provider.getAuthType();
    }
    var authData = this.get('authData');
    if (!provider || typeof authData !== 'object') {
      return;
    }
    var success = provider.restoreAuthentication(authData[authType]);
    if (!success) {
      this._unlinkFrom(provider);
    }
  }

  /**
   * Synchronizes authData for all providers.
   * @method _synchronizeAllAuthData
   */
  _synchronizeAllAuthData() {
    var authData = this.get('authData');
    if (typeof authData !== 'object') {
      return;
    }

    for (var key in authData) {
      this._synchronizeAuthData(key);
    }
  }

  /**
   * Removes null values from authData (which exist temporarily for
   * unlinking)
   * @method _cleanupAuthData
   */
  _cleanupAuthData() {
    if (!this.isCurrent()) {
      return;
    }
    var authData = this.get('authData');
    if (typeof authData !== 'object') {
      return;
    }

    for (var key in authData) {
      if (!authData[key]) {
        delete authData[key];
      }
    }
  }

  /**
   * Unlinks a user from a service.
   * @method _unlinkFrom
   */
  _unlinkFrom(provider, options?: FullOptions) {
    var authType;
    if (typeof provider === 'string') {
      authType = provider;
      provider = authProviders[provider];
    } else {
      authType = provider.getAuthType();
    }
    return this._linkWith(provider, { authData: null }).then(() => {
      this._synchronizeAuthData(provider);
      return ParsePromise.as(this);
    })._thenRunCallbacks(options);
  }

  /**
   * Checks whether a user is linked to a service.
   * @method _isLinked
   */
  _isLinked(provider): boolean {
    var authType;
    if (typeof provider === 'string') {
      authType = provider;
    } else {
      authType = provider.getAuthType();
    }
    var authData = this.get('authData') || {};
    return !!authData[authType];
  }

  /**
   * Deauthenticates all providers.
   * @method _logOutWithAll
   */
  _logOutWithAll() {
    var authData = this.get('authData');
    if (typeof authData !== 'object') {
      return;
    }

    for (var key in authData) {
      this._logOutWith(key);
    }
  }

  /**
   * Deauthenticates a single provider (e.g. removing access tokens from the
   * Facebook SDK).
   * @method _logOutWith
   */
  _logOutWith(provider) {
    if (!this.isCurrent()) {
      return;
    }
    if (typeof provider === 'string') {
      provider = authProviders[provider];
    }
    if (provider && provider.deauthenticate) {
      provider.deauthenticate();
    }
  }

  /**
   * Returns true if <code>current</code> would return this user.
   * @method isCurrent
   * @return {Boolean}
   */
  isCurrent(): boolean {
    var current = ParseUser.current();
    return !!current && current.id === this.id;
  }

  /**
   * Returns get("username").
   * @method getUsername
   * @return {String}
   */
  getUsername(): ?string {
    return this.get('username');
  }

  /**
   * Calls set("username", username, options) and returns the result.
   * @method setUsername
   * @param {String} username
   * @param {Object} options A Backbone-style options object.
   * @return {Boolean}
   */
  setUsername(username: string) {
    // Strip anonymity, even we do not support anonymous user in js SDK, we may
    // encounter anonymous user created by android/iOS in cloud code.
    var authData = this.get('authData');
    if (authData && authData.hasOwnProperty('anonymous')) {
      // We need to set anonymous to null instead of deleting it in order to remove it from Parse.
      authData.anonymous = null;
    }
    this.set('username', username);
  }

  /**
   * Calls set("password", password, options) and returns the result.
   * @method setPassword
   * @param {String} password
   * @param {Object} options A Backbone-style options object.
   * @return {Boolean}
   */
  setPassword(password: string) {
    this.set('password', password);
  }

  /**
   * Returns get("email").
   * @method getEmail
   * @return {String}
   */
  getEmail(): ?string {
    return this.get('email');
  }

  /**
   * Calls set("email", email, options) and returns the result.
   * @method setEmail
   * @param {String} email
   * @param {Object} options A Backbone-style options object.
   * @return {Boolean}
   */
  setEmail(email: string) {
    this.set('email', email);
  }

  /**
   * Returns the session token for this user, if the user has been logged in,
   * or if it is the result of a query with the master key. Otherwise, returns
   * undefined.
   * @method getSessionToken
   * @return {String} the session token, or undefined
   */
  getSessionToken(): ?string {
    return this.get('sessionToken');
  }

  /**
   * Checks whether this user is the current user and has been authenticated.
   * @method authenticated
   * @return (Boolean) whether this user is the current user and is logged in.
   */
  authenticated(): boolean {
    var current = ParseUser.current();
    return (
      !!this.get('sessionToken') &&
      !!current &&
      current.id === this.id
    );
  }

  /**
   * Signs up a new user. You should call this instead of save for
   * new Parse.Users. This will create a new Parse.User on the server, and
   * also persist the session on disk so that you can access the user using
   * <code>current</code>.
   *
   * <p>A username and password must be set before calling signUp.</p>
   *
   * <p>Calls options.success or options.error on completion.</p>
   *
   * @method signUp
   * @param {Object} attrs Extra fields to set on the new user, or null.
   * @param {Object} options A Backbone-style options object.
   * @return {Parse.Promise} A promise that is fulfilled when the signup
   *     finishes.
   */
  signUp(attrs: AttributeMap, options: FullOptions) {
    options = options || {};

    var signupOptions = {};
    if (options.hasOwnProperty('useMasterKey')) {
      signupOptions.useMasterKey = options.useMasterKey;
    }

    var controller = CoreManager.getUserController();
    return controller.signUp(
      this,
      attrs,
      signupOptions
    )._thenRunCallbacks(options, this);
  }

  /**
   * Logs in a Parse.User. On success, this saves the session to disk,
   * so you can retrieve the currently logged in user using
   * <code>current</code>.
   *
   * <p>A username and password must be set before calling logIn.</p>
   *
   * <p>Calls options.success or options.error on completion.</p>
   *
   * @method logIn
   * @param {Object} options A Backbone-style options object.
   * @return {Parse.Promise} A promise that is fulfilled with the user when
   *     the login is complete.
   */
  logIn(options: FullOptions) {
    options = options || {};

    var loginOptions = {};
    if (options.hasOwnProperty('useMasterKey')) {
      loginOptions.useMasterKey = options.useMasterKey;
    }

    var controller = CoreManager.getUserController();
    return controller.logIn(this, loginOptions)._thenRunCallbacks(options, this);
  }

  /**
   * Wrap the default save behavior with functionality to save to local
   * storage if this is current user.
   */
  save(...args) {
    return super.save.apply(this, args).then(() => {
      if (this.isCurrent()) {
        return CoreManager.getUserController().updateUserOnDisk(this);
      }
      return this;
    });
  }

  /**
   * Wrap the default fetch behavior with functionality to save to local
   * storage if this is current user.
   */
  fetch(...args) {
    return super.fetch.apply(this, args).then(() => {
      if (this.isCurrent()) {
        return CoreManager.getUserController().updateUserOnDisk(this);
      }
      return this;
    });
  }

  static readOnlyAttributes() {
    return ['sessionToken'];
  }

  /**
   * Adds functionality to the existing Parse.User class
   * @method extend
   * @param {Object} protoProps A set of properties to add to the prototype
   * @param {Object} classProps A set of static properties to add to the class
   * @static
   * @return {Class} The newly extended Parse.User class
   */
  static extend(protoProps, classProps) {
    if (protoProps) {
      for (var prop in protoProps) {
        if (prop !== 'className') {
          Object.defineProperty(ParseUser.prototype, prop, {
            value: protoProps[prop],
            enumerable: false,
            writable: true,
            configurable: true
          });
        }
      }
    }

    if (classProps) {
      for (var prop in classProps) {
        if (prop !== 'className') {
          Object.defineProperty(ParseUser, prop, {
            value: classProps[prop],
            enumerable: false,
            writable: true,
            configurable: true
          });
        }
      }
    }

    return ParseUser;
  }

  /**
   * Retrieves the currently logged in ParseUser with a valid session,
   * either from memory or localStorage, if necessary.
   * @method current
   * @static
   * @return {Parse.Object} The currently logged in Parse.User.
   */
  static current(): ?ParseUser {
    if (!canUseCurrentUser) {
      return null;
    }
    var controller = CoreManager.getUserController();
    return controller.currentUser();
  }

  /**
   * Retrieves the currently logged in ParseUser from asynchronous Storage.
   * @method currentAsync
   * @static
   * @return {Parse.Promise} A Promise that is resolved with the currently
   *   logged in Parse User
   */
  static currentAsync(): ParsePromise {
    if (!canUseCurrentUser) {
      return ParsePromise.as(null);
    }
    var controller = CoreManager.getUserController();
    return controller.currentUserAsync();
  }

  /**
   * Signs up a new user with a username (or email) and password.
   * This will create a new Parse.User on the server, and also persist the
   * session in localStorage so that you can access the user using
   * {@link #current}.
   *
   * <p>Calls options.success or options.error on completion.</p>
   *
   * @method signUp
   * @param {String} username The username (or email) to sign up with.
   * @param {String} password The password to sign up with.
   * @param {Object} attrs Extra fields to set on the new user.
   * @param {Object} options A Backbone-style options object.
   * @static
   * @return {Parse.Promise} A promise that is fulfilled with the user when
   *     the signup completes.
   */
  static signUp(username, password, attrs, options) {
    attrs = attrs || {};
    attrs.username = username;
    attrs.password = password;
    var user = new ParseUser(attrs);
    return user.signUp({}, options);
  }

  /**
   * Logs in a user with a username (or email) and password. On success, this
   * saves the session to disk, so you can retrieve the currently logged in
   * user using <code>current</code>.
   *
   * <p>Calls options.success or options.error on completion.</p>
   *
   * @method logIn
   * @param {String} username The username (or email) to log in with.
   * @param {String} password The password to log in with.
   * @param {Object} options A Backbone-style options object.
   * @static
   * @return {Parse.Promise} A promise that is fulfilled with the user when
   *     the login completes.
   */
  static logIn(username, password, options) {
    var user = new ParseUser();
    user._finishFetch({ username: username, password: password });
    return user.logIn(options);
  }

  /**
   * Logs in a user with a session token. On success, this saves the session
   * to disk, so you can retrieve the currently logged in user using
   * <code>current</code>.
   *
   * <p>Calls options.success or options.error on completion.</p>
   *
   * @method become
   * @param {String} sessionToken The sessionToken to log in with.
   * @param {Object} options A Backbone-style options object.
   * @static
   * @return {Parse.Promise} A promise that is fulfilled with the user when
   *     the login completes.
   */
  static become(sessionToken, options) {
    if (!canUseCurrentUser) {
      throw new Error(
        'It is not memory-safe to become a user in a server environment'
      );
    }
    options = options || {};

    var becomeOptions: RequestOptions = {
      sessionToken: sessionToken
    };
    if (options.hasOwnProperty('useMasterKey')) {
      becomeOptions.useMasterKey = options.useMasterKey;
    }

    var controller = CoreManager.getUserController();
    return controller.become(becomeOptions)._thenRunCallbacks(options);
  }

  static logInWith(provider, options) {
    return ParseUser._logInWith(provider, options);
  }

  /**
   * Logs out the currently logged in user session. This will remove the
   * session from disk, log out of linked services, and future calls to
   * <code>current</code> will return <code>null</code>.
   * @method logOut
   * @static
   * @return {Parse.Promise} A promise that is resolved when the session is
   *   destroyed on the server.
   */
  static logOut() {
    if (!canUseCurrentUser) {
      throw new Error(
        'There is no current user user on a node.js server environment.'
      );
    }

    var controller = CoreManager.getUserController();
    return controller.logOut();
  }

  /**
   * Requests a password reset email to be sent to the specified email address
   * associated with the user account. This email allows the user to securely
   * reset their password on the Parse site.
   *
   * <p>Calls options.success or options.error on completion.</p>
   *
   * @method requestPasswordReset
   * @param {String} email The email address associated with the user that
   *     forgot their password.
   * @param {Object} options A Backbone-style options object.
   * @static
   */
  static requestPasswordReset(email, options) {
    options = options || {};

    var requestOptions = {};
    if (options.hasOwnProperty('useMasterKey')) {
      requestOptions.useMasterKey = options.useMasterKey;
    }

    var controller = CoreManager.getUserController();
    return controller.requestPasswordReset(
      email, requestOptions
    )._thenRunCallbacks(options);
  }

  /**
   * Allow someone to define a custom User class without className
   * being rewritten to _User. The default behavior is to rewrite
   * User to _User for legacy reasons. This allows developers to
   * override that behavior.
   *
   * @method allowCustomUserClass
   * @param {Boolean} isAllowed Whether or not to allow custom User class
   * @static
   */
  static allowCustomUserClass(isAllowed: boolean) {
    CoreManager.set('PERFORM_USER_REWRITE', !isAllowed);
  }

  /**
   * Allows a legacy application to start using revocable sessions. If the
   * current session token is not revocable, a request will be made for a new,
   * revocable session.
   * It is not necessary to call this method from cloud code unless you are
   * handling user signup or login from the server side. In a cloud code call,
   * this function will not attempt to upgrade the current token.
   * @method enableRevocableSession
   * @param {Object} options A Backbone-style options object.
   * @static
   * @return {Parse.Promise} A promise that is resolved when the process has
   *   completed. If a replacement session token is requested, the promise
   *   will be resolved after a new token has been fetched.
   */
  static enableRevocableSession(options) {
    options = options || {};
    CoreManager.set('FORCE_REVOCABLE_SESSION', true);
    if (canUseCurrentUser) {
      var current = ParseUser.current();
      if (current) {
        return current._upgradeToRevocableSession(options);
      }
    }
    return ParsePromise.as()._thenRunCallbacks(options);
  }

  /**
   * Enables the use of become or the current user in a server
   * environment. These features are disabled by default, since they depend on
   * global objects that are not memory-safe for most servers.
   * @method enableUnsafeCurrentUser
   * @static
   */
  static enableUnsafeCurrentUser() {
    canUseCurrentUser = true;
  }

  /**
   * Disables the use of become or the current user in any environment.
   * These features are disabled on servers by default, since they depend on
   * global objects that are not memory-safe for most servers.
   * @method disableUnsafeCurrentUser
   * @static
   */
  static disableUnsafeCurrentUser() {
    canUseCurrentUser = false;
  }

  static _registerAuthenticationProvider(provider) {
    authProviders[provider.getAuthType()] = provider;
    // Synchronize the current user with the auth provider.
    ParseUser.currentAsync().then((current) => {
      if (current) {
        current._synchronizeAuthData(provider.getAuthType());
      }
    });
  }

  static _logInWith(provider, options) {
    var user = new ParseUser();
    return user._linkWith(provider, options);
  }

  static _clearCache() {
    currentUserCache.set(null);
    currentUserCacheMatchesDisk = false;
  }

  static _setCurrentUserCache(user) {
    currentUserCache.set(user);
  }
}

ParseObject.registerSubclass('_User', ParseUser);

var DefaultController = {
  updateUserOnDisk(user) {
    var path = Storage.generatePath(CURRENT_USER_KEY);
    var json = user.toJSON();
    json.className = '_User';
    return Storage.setItemAsync(
      path, JSON.stringify(json)
    ).then(() => {
      return user;
    });
  },

  setCurrentUser(user) {
    currentUserCache.set(user);
    user._cleanupAuthData();
    user._synchronizeAllAuthData();
    return DefaultController.updateUserOnDisk(user);
  },

  currentUser(): ?ParseUser {
  	var cache = currentUserCache.get();
    if (cache) {
      return cache;
    }
    if (currentUserCacheMatchesDisk) {
      return null;
    }
    if (Storage.async()) {
      throw new Error(
        'Cannot call currentUser() when using a platform with an async ' +
        'storage system. Call currentUserAsync() instead.'
      );
    }
    var path = Storage.generatePath(CURRENT_USER_KEY);
    var userData = Storage.getItem(path);
    currentUserCacheMatchesDisk = true;
    if (!userData) {
      currentUserCache.set(null);
      return null;
    }
    userData = JSON.parse(userData);
    if (!userData.className) {
      userData.className = '_User';
    }
    if (userData._id) {
      if (userData.objectId !== userData._id) {
        userData.objectId = userData._id;
      }
      delete userData._id;
    }
    if (userData._sessionToken) {
      userData.sessionToken = userData._sessionToken;
      delete userData._sessionToken;
    }
    var current = ParseObject.fromJSON(userData);
    currentUserCache.set(current);
    current._synchronizeAllAuthData();
    return current;
  },

  currentUserAsync(): ParsePromise {
  	var cache = currentUserCache.get();
    if (cache) {
      return ParsePromise.as(cache)
    }
    if (currentUserCacheMatchesDisk) {
      return ParsePromise.as(null);
    }
    var path = Storage.generatePath(CURRENT_USER_KEY);
    return Storage.getItemAsync(
      path
    ).then((userData) => {
      currentUserCacheMatchesDisk = true;
      if (!userData) {
        currentUserCache.set(null);
        return ParsePromise.as(null);
      }
      userData = JSON.parse(userData);
      if (!userData.className) {
        userData.className = '_User';
      }
      if (userData._id) {
        if (userData.objectId !== userData._id) {
          userData.objectId = userData._id;
        }
        delete userData._id;
      }
      if (userData._sessionToken) {
        userData.sessionToken = userData._sessionToken;
        delete userData._sessionToken;
      }
      var current = ParseObject.fromJSON(userData);
      currentUserCache.set(current);
      current._synchronizeAllAuthData();
      return ParsePromise.as(current);
    });
  },

  signUp(user: ParseUser, attrs: AttributeMap, options: RequestOptions): ParsePromise {
    var username = (attrs && attrs.username) || user.get('username');
    var password = (attrs && attrs.password) || user.get('password');

    if (!username || !username.length) {
      return ParsePromise.error(
        new ParseError(
          ParseError.OTHER_CAUSE,
          'Cannot sign up user with an empty name.'
        )
      );
    }
    if (!password || !password.length) {
      return ParsePromise.error(
        new ParseError(
          ParseError.OTHER_CAUSE,
          'Cannot sign up user with an empty password.'
        )
      );
    }

    return user.save(attrs, options).then(() => {
      // Clear the password field
      user._finishFetch({ password: undefined });

      if (canUseCurrentUser) {
        return DefaultController.setCurrentUser(user);
      }
      return user;
    });
  },

  logIn(user: ParseUser, options: RequestOptions): ParsePromise {
    var RESTController = CoreManager.getRESTController();
    var auth = {
      username: user.get('username'),
      password: user.get('password')
    };
    return RESTController.request(
      'GET', 'login', auth, options
    ).then((response, status) => {
      user._migrateId(response.objectId);
      user._setExisted(true);
      ObjectState.setPendingOp(
        user.className, user._getId(), 'username', undefined
      );
      ObjectState.setPendingOp(
        user.className, user._getId(), 'password', undefined
      );
      response.password = undefined;
      user._finishFetch(response);
      if (!canUseCurrentUser) {
        // We can't set the current user, so just return the one we logged in
        return ParsePromise.as(user);
      }
      return DefaultController.setCurrentUser(user);
    });
  },

  become(options: RequestOptions): ParsePromise {
    var user = new ParseUser();
    var RESTController = CoreManager.getRESTController();
    return RESTController.request(
      'GET', 'users/me', {}, options
    ).then((response, status) => {
      user._finishFetch(response);
      user._setExisted(true);
      return DefaultController.setCurrentUser(user);
    });
  },

  logOut(): ParsePromise {
    return DefaultController.currentUserAsync().then((currentUser) => {
      var path = Storage.generatePath(CURRENT_USER_KEY);
      var promise = Storage.removeItemAsync(path);
      var RESTController = CoreManager.getRESTController();
      if (currentUser !== null) {
        var currentSession = currentUser.getSessionToken();
        if (currentSession && isRevocableSession(currentSession)) {
          promise = promise.then(() => {
            return RESTController.request(
              'POST', 'logout', {}, { sessionToken: currentSession }
            );
          });
        }
        currentUser._logOutWithAll();
        currentUser._finishFetch({ sessionToken: undefined });
      }
      currentUserCacheMatchesDisk = true;
      currentUserCache.set(null);

      return promise;
    });
  },

  requestPasswordReset(email: string, options: RequestOptions) {
    var RESTController = CoreManager.getRESTController();
    return RESTController.request(
      'POST',
      'requestPasswordReset',
      { email: email },
      options
    );
  },

  upgradeToRevocableSession(user: ParseUser, options: RequestOptions) {
    var token = user.getSessionToken();
    if (!token) {
      return ParsePromise.error(
        new ParseError(
          ParseError.SESSION_MISSING,
          'Cannot upgrade a user with no session token'
        )
      );
    }

    options.sessionToken = token;

    var RESTController = CoreManager.getRESTController();
    return RESTController.request(
      'POST',
      'upgradeToRevocableSession',
      {},
      options
    ).then((result) => {
      var session = new ParseSession();
      session._finishFetch(result);
      user._finishFetch({ sessionToken: session.getSessionToken() });
      if (user.isCurrent()) {
        return DefaultController.setCurrentUser(user);
      }
      return ParsePromise.as(user);
    });
  },

  linkWith(user: ParseUser, authData: AuthData) {
    return user.save({ authData }).then(() => {
      if (canUseCurrentUser) {
        return DefaultController.setCurrentUser(user);
      }
      return user;
    });
  }
};

CoreManager.setUserController(DefaultController);
