// Imports
import express from 'express';
import passport from 'passport';
import session from 'express-session';
import {
	Profile as DiscordProfile,
	Strategy as DiscordStrategy,
	VerifyCallback as DiscordVerifyCallback,
} from '@oauth-everything/passport-discord';
import { Strategy as BearerStrategy } from 'passport-http-bearer';
import { BasicStrategy } from 'passport-http';
import { Strategy as ClientPasswordStrategy } from 'passport-oauth2-client-password';
import Discord from 'discord.js';
import mongoose from 'mongoose';
import oauth2orize from 'oauth2orize';

// Models
import intformat from 'biguint-format';
import FlakeId from 'flake-idgen';
import User, { Type as UserType } from './models/User';
import GroupLink from './models/GroupLink';
import Application, { Type as ApplicationType } from './models/Application';
import Code, { Type as CodeType } from './models/Code';
import AccessToken, { Type as AccessTokenType } from './models/AccessToken';

// Local files
import { updateUserGroups, updateUserGroupsByKey, findUserByKey } from './jira';
import { uid } from './util';

// Routers
import holoresRouter from './holores';

const config = require('../config.json');

const MongoDBStore = require('connect-mongodb-session')(session);

// Init
// eslint-disable-next-line import/prefer-default-export
export const client = new Discord.Client();
const flakeIdGen = new FlakeId();
const oauth2Server = oauth2orize.createServer();

const app = express();
app.use(express.urlencoded());
app.use(express.json());

const store = new MongoDBStore({
	uri: `mongodb+srv://${config.mongodb.username}:${config.mongodb.password}@${config.mongodb.host}/${config.mongodb.database}`,
	collection: 'sessions',
});

const sessionOptions = {
	secret: config.expressSessionSecret,
	cookie: {
		secure: false,
		maxAge: 1000 * 60 * 60 * 24 * 7,
	},
	store,
	resave: false,
	saveUninitialized: false,
};

if (app.get('env') === 'production') {
	app.set('trust proxy', 2); // trust first two proxies, CF and IIS
	sessionOptions.cookie.secure = true; // serve secure cookies
}

app.use(session(sessionOptions));
app.use(passport.initialize());
app.use(passport.session());
app.listen(config.port);

// MongoDB
mongoose.connect(`mongodb+srv://${config.mongodb.username}:${config.mongodb.password}@${config.mongodb.host}/${config.mongodb.database}`, {
	useNewUrlParser: true,
	useUnifiedTopology: true,
	useFindAndModify: false,
});

// Passport
// @ts-expect-error _id doesn't exist on user
passport.serializeUser((user, done) => done(null, user._id));

passport.deserializeUser((id, done) => {
	User.findById(id, (error: any, user: any) => done(error, user));
});

// eslint-disable-next-line max-len
passport.use(new DiscordStrategy(config.discord, async (accessToken: string, refreshToken: string, profile: DiscordProfile, cb: DiscordVerifyCallback<UserType>) => {
	const guild = await client.guilds.fetch(config.discordServerId).catch((err) => {
		throw new Error(err);
	});

	// @ts-expect-error Not a valid Error type
	const member = await guild?.members.fetch(profile.id).catch(() => cb("You don't have the required permissions to login"));

	const baseRole = await GroupLink.findOne({ baseRole: true }).lean().exec().catch((err) => {
		throw new Error(err);
	});

	// @ts-expect-error baseRole possibly null
	if (!member?.user || !member.roles.cache.has(baseRole?._id)) cb("You don't have the required permissions to login");
	else {
		User.findById(profile.id, async (err: any, doc: UserType) => {
			if (err) throw new Error(err);
			if (!doc) {
				const newUser = new User({
					_id: profile.id,
					username: profile.username,
				});
				newUser.save((err2: any) => {
					if (err2) throw new Error(err2);
				});
				// @ts-expect-error Possible undefined
				updateUserGroups(profile.id, profile.username).then(() => {
					User.findById(profile.id, (err3: any, user: UserType) => {
						if (err3) throw new Error(err3);
						cb(null, user);
					}).catch((err4) => {
						console.log(err4);
					});
				});
			} else {
				if (!doc.jiraKey) {
					// @ts-expect-error Possible undefined
					updateUserGroups(profile.id, profile.username).then(() => {
						User.findById(profile.id, (err3: any, user: UserType) => {
							if (err3) throw new Error(err3);
							cb(null, user);
						}).catch((err2) => {
							console.log(err2);
						});
					});
				}
				updateUserGroupsByKey(profile.id, <string>doc.jiraKey).then(() => {
					cb(null, doc);
				});
			}
		});
	}
}));

passport.use(new BearerStrategy((accessToken, callback) => {
	AccessToken.findOne({ token: accessToken }, (err: any, token: AccessTokenType) => {
		if (err) return callback(err);

		// No token found
		if (!token) return callback(null, false);

		User.findById(token.userId, (err2: any, user: UserType) => {
			if (err) return callback(err2);

			// No user found
			if (!user) return callback(null, false);
			// Simple example with no scope
			updateUserGroupsByKey(user._id, <string>user.jiraKey).then(() => {
				findUserByKey(<string>user.jiraKey).then((jiraUser) => {
					callback(null, {
						...user._doc,
						jiraUsername: jiraUser.name,
						username: jiraUser.name,
						displayName: jiraUser.name,
						email: user.mailcowEmail,
						id: jiraUser.name,
					}, { scope: '*' });
				});
			});
		});
	});
}));

passport.use('client-basic', new BasicStrategy((clientId, clientSecret, callback) => {
	Application.findById(clientId, (err: any, oauthClient: ApplicationType) => {
		if (err) return callback(err);

		if (!oauthClient || oauthClient.clientSecret !== clientSecret) return callback(null, false);
		return callback(null, oauthClient);
	});
}));

passport.use(new ClientPasswordStrategy((clientId, clientSecret, callback) => {
	Application.findById(clientId, (err: any, oauthClient: ApplicationType) => {
		if (err) return callback(err);

		if (!oauthClient || oauthClient.clientSecret !== clientSecret) return callback(null, false);
		return callback(null, oauthClient);
	});
}));

// app.use('/holores', holoresRouter);

// Discord
client.on('ready', () => {
	// eslint-disable-next-line no-console
	console.log('Discord client online');
	// @ts-expect-error User possibly undefined
	client.user.setStatus('invisible');
});
client.login(config.discordToken);

// OAuth2.0
oauth2Server.serializeClient((oauthClient, done) => done(null, oauthClient._id));

oauth2Server.deserializeClient((id, done) => {
	Application.findById(id, (error: any, oauthClient: any) => done(error, oauthClient));
});

oauth2Server.grant(oauth2orize.grant.code((oauthClient, redirectUri, user, ares, callback) => {
	const code: CodeType = new Code({
		token: uid(16),
		clientId: oauthClient._id,
		redirectUri,
		userId: user._id,
	});

	code.save((err) => {
		if (err) callback(err);
		else callback(null, code.token);
	});
}));

oauth2Server.exchange(oauth2orize.exchange.code((oauthClient, code, redirectUri, callback) => {
	Code.findOne({ token: code }, (err: any, authCode: CodeType) => {
		if (err) return callback(err);
		// eslint-disable-next-line max-len
		if (!authCode || oauthClient._id !== authCode.clientId || redirectUri !== authCode.redirectUri) return callback(null, false);

		// @ts-expect-error Callback is not options
		Code.findByIdAndDelete(authCode._id, (err2: any) => {
			if (err2) return callback(err2);

			const token = new AccessToken({
				token: uid(256),
				clientId: authCode.clientId,
				userId: authCode.userId,
			});

			token.save((err3) => {
				if (err3) return callback(err3);
				callback(null, token.token);
			});
		});
	});
}));

// Routes
app.get('/auth/fail', (req, res) => {
	res.status(500).send("Sign in failed, you possibly don't have the required permissions to login");
});

app.get('/auth/logout', (req, res) => {
	req.logout();
	// @ts-expect-error not assignable to string
	if (req.query.redirectUrl) res.redirect(req.query.redirectUrl);
	else res.status(200).send('Signed out');
});

app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback', passport.authenticate('discord', {
	failureRedirect: '/auth/fail',
}), async (req, res) => {
	const guild = await client.guilds.fetch(config.discordServerId).catch((err3) => {
		throw new Error(err3);
	});
	// @ts-expect-error Id not defined in User
	const member = await guild?.members.fetch(req.user?.id).catch(() => res.status(401).send("You don't have the required permissions to login"));

	const baseRole = await GroupLink.findOne({ baseRole: true }).lean().exec().catch(() => {
		res.status(500).send('Internal Server Error');
	});

	// @ts-expect-error member.roles and _id possibly undefined
	if (!member.roles.cache.has(baseRole?._id)) return res.status(401).send("You don't have the required permissions to login");
	// @ts-expect-error redirect does not exist in the type
	if (req.session.redirect) {
		// @ts-expect-error redirect does not exist
		const { redirect } = req.session;
		// @ts-expect-error redirect does not exist
		req.session.redirect = undefined;
		return res.redirect(redirect);
	} res.status(200).send('Signed in');
});

app.post('/oauth2/token', [passport.authenticate(['client-basic', 'oauth2-client-password'], { session: false }), oauth2Server.token(), oauth2Server.errorHandler()]);

app.get('/oauth2/authorize',
	(req, res, next) => {
		// @ts-expect-error never
		if (!req.session) req.session.regenerate();
		// @ts-expect-error redirect does not exist
		req.session.redirect = req.originalUrl;
		next();
	},
	(req, res, next) => {
		if (!req.isAuthenticated()) res.redirect('/auth/discord');
		else next();
	},
	oauth2Server.authorize((clientID, redirectURI, done) => {
		Application.findById(clientID, (err:any, oauthClient: ApplicationType) => {
			if (err) { return done(err); }
			if (!oauthClient) { return done(null, false); }
			if (oauthClient.redirectUrl !== redirectURI) { return done(null, false); }
			return done(null, oauthClient, oauthClient.redirectUrl);
		});
	}),
	oauth2Server.decision());

app.get('/api/userinfo', passport.authenticate('bearer', { session: false }), (req, res) => {
	res.status(200).json(req.user);
});

app.get('/api/userByJiraKey', passport.authenticate('client-basic', { session: false }), (req, res) => {
	// @ts-expect-error Not assignable to
	User.findOne({ jiraKey: req.query.key }).lean()
		.exec((err, doc) => {
			if (err) return res.status(500).end();
			res.status(200).json(doc);
		});
});

app.get('/api/userByDiscordId', passport.authenticate('client-basic', { session: false }), (req, res) => {
	User.findById(req.query.id).lean()
		.exec((err, doc) => {
			if (err) return res.status(500).end();
			// @ts-expect-error doc possibly undefined
			findUserByKey(doc.jiraKey)
				.then((jiraUser) => {
					res.status(200).json({
						...doc,
						username: jiraUser.name,
					});
				});
		});
});

app.post('/admin/application', (req, res) => {
	if (req.get('Authorization') !== config.adminToken) res.status(403).end();
	const application = new Application({
		_id: intformat(flakeIdGen.next(), 'dec').toString(),
		...req.body,
		clientSecret: uid(16),
	});
	application.save((err) => {
		if (err) res.status(500).send(err);
		else res.status(201).json(application);
	});
});

app.delete('/admin/application', (req, res) => {
	if (req.get('Authorization') !== config.adminToken) res.status(403).end();
	Application.findByIdAndDelete(req.body.id).exec((err, application) => {
		if (err) res.status(500).send(err);
		if (!application) res.status(404).end();
		else res.status(200).json(application);
	});
});

app.get('/admin/application', (req, res) => {
	if (req.get('Authorization') !== config.adminToken) res.status(403).end();
	Application.findById(req.query.id).exec((err, application) => {
		if (err) res.status(500).send(err);
		if (!application) res.status(404).end();
		else res.status(200).json(application);
	});
});

app.post('/admin/groupLink', (req, res) => {
	if (req.get('Authorization') !== config.adminToken) res.status(403).end();
	const link = new GroupLink(req.body);
	link.save((err) => {
		if (err) res.status(500).send(err);
		else res.status(201).json(link);
	});
});

app.delete('/admin/groupLink', (req, res) => {
	if (req.get('Authorization') !== config.adminToken) res.status(403).end();
	GroupLink.findByIdAndDelete(req.body.id).exec((err, link) => {
		if (err) res.status(500).send(err);
		if (!link) res.status(404).end();
		else res.status(200).json(link);
	});
});

app.get('/admin/groupLink', (req, res) => {
	if (req.get('Authorization') !== config.adminToken) res.status(403).end();
	GroupLink.findById(req.query.id).exec((err, link) => {
		if (err) res.status(500).send(err);
		if (!link) res.status(404).end();
		else res.status(200).json(link);
	});
});
