// Imports
import axios from 'axios';
import Discord from 'discord.js';

// Local files
import generator from 'generate-password';
import { CreatedUser, User } from './types';
import { client } from './index';
import GroupLink, { Type as GroupLinkType } from './models/GroupLink';
import UserDoc, { Type as UserType, Type as UserDocType } from './models/User';

const config = require('../config.json');

// Variables
const url = `${config.jira.url}/rest/api/latest`;
const emailRegex = /^([0-z]|-)+$/i;

// eslint-disable-next-line max-len
const createUser = (username: string, email: string, discordId: string): Promise<CreatedUser> => new Promise((resolve, reject) => {
	axios.post(`${url}/user`, {
		name: username,
		emailAddress: email,
		displayName: username,
		applicationKeys: [
			'jira-software',
		],
	}, {
		auth: {
			username: config.jira.username,
			password: config.jira.apiToken,
		},
	}).then((res) => {
		UserDoc.findById(discordId, async (err: any, doc: UserDocType) => {
			if (err) throw new Error(err);
			// eslint-disable-next-line no-param-reassign
			doc.jiraKey = res.data.key;
			await doc.save();
			resolve(res.data);
		});
	}).catch(reject);
});

// eslint-disable-next-line max-len
const findUser = (username: string, email: string, discordId: string): Promise<User> => new Promise((resolve, reject) => {
	axios.get(`${url}/user`, {
		params: { username, expand: 'groups' },
		auth: {
			username: config.jira.username,
			password: config.jira.apiToken,
		},
	}).then((res) => {
		resolve(res.data);
	}).catch((err) => {
		if (err.response?.status === 404) {
			createUser(username, email, discordId)
				.then(() => findUser(username, email, discordId).then(resolve)).catch(reject);
		} else reject(new Error(err));
	});
});

export const findUserByKey = (key: string): Promise<User> => new Promise((resolve, reject) => {
	axios.get(`${url}/user`, {
		params: { key, expand: 'groups' },
		auth: {
			username: config.jira.username,
			password: config.jira.apiToken,
		},
	}).then((res) => {
		resolve(res.data);
	}).catch((err) => {
		console.log(err.response?.data);
		reject(new Error(err));
	});
});

// eslint-disable-next-line max-len
const createEmail = (member: Discord.GuildMember, user: UserDocType): Promise<string> => new Promise((resolve, reject) => {
	const generatedPassword = generator.generate({
		length: 14,
		numbers: true,
		strict: true,
	});

	let username = member.user.username.replace(/\s/g, '-').toLowerCase();
	let valid = emailRegex.test(username);
	if (!valid) {
		member.user.send('Your Discord username is not a valid for an email address. Please respond in 1 minute with a proper alphanumerical username.')
			.then((msg) => {
				// eslint-disable-next-line max-len
				const collector = msg.channel.createMessageCollector((message) => message.author.id === member.user.id, { time: 60 * 1000 });

				collector.on('collect', (message) => {
					valid = emailRegex.test(message.content.replace(/\s/g, '-').toLowerCase());
					if (!valid) member.user.send('Invalid username');
					else {
						username = message.content.replace(/\s/g, '-').toLowerCase();
						// eslint-disable-next-line no-use-before-define
						createEmailRequest();
						collector.stop();
					}
				});

				collector.on('end', (collected) => {
					if (collected.size === 0 || !valid) {
						member.user.send('No valid username recorded, please put in a request for an email here: https://holores.atlassian.net/servicedesk/customer/portal/3, or login once again to restart the process. ');
						reject();
					}
				});
			});
		// eslint-disable-next-line no-use-before-define
	} else createEmailRequest();

	function createEmailRequest(): void {
		console.log(generatedPassword); // ! TODO: REMOVE IN PRODUCTION
		axios.post(`${config.mailcow.url}/api/v1/add/mailbox`, {
			active: 1,
			domain: config.mailcow.tlDomain,
			local_part: username,
			password: generatedPassword,
			password2: generatedPassword,
			quota: 3072,
			force_pw_update: 1,
		}, {
			headers: {
				'X-API-Key': config.mailcow.apiKey,
			},
		})
			.then(() => {
				// eslint-disable-next-line no-param-reassign
				user.mailcowEmail = `${username}@${config.mailcow.tlDomain}`;
				user.save();
				member.user.send(`Email has been automatically created:
Email: \`${member.user.username}@${config.mailcow.tlDomain}\`
Password: \`${generatedPassword}\`
Please immediately change your password here: ${config.mailcow.url}
If you have any issues or want to setup email forwarding, check the internal wiki. If you still can't figure it out, contact support.
		`);
				resolve(user.mailcowEmail);
			})
			.catch(console.error);
	}
});

// eslint-disable-next-line max-len,no-async-promise-executor
export const updateUserGroups = (discordId: string, username: string): Promise<void|UserDocType> => new Promise(async (resolve, reject) => {
	const guild = await client.guilds.fetch(config.discordServerId).catch(reject);
	// @ts-expect-error guild.members possibly undefined
	const member = await guild?.members.fetch(discordId).catch(reject);

	const userDoc = await UserDoc.findById(discordId).exec()
		.catch((e) => {
			throw e;
		});
	let email = userDoc?.mailcowEmail ?? undefined;
	if (!email) email = await createEmail(member, <UserDocType>userDoc);

	findUser(username, email, discordId).then(async (user) => {
		// @ts-expect-error Possible void
		const groupLinks: Array<GroupLinkType> = await GroupLink.find({}).lean().exec()
			.catch(reject);

		UserDoc.findById(discordId, (err: any, doc: UserType) => {
			if (err) return;
			if (doc && !doc.jiraKey) {
				// eslint-disable-next-line no-param-reassign
				doc.jiraKey = user.key;
				doc.save();
			}
		});

		user.groups.items.forEach((group) => {
			const link = groupLinks.find((item) => item.jiraName === group.name);
			if (link && !member.roles.cache.has(link._id)) {
				axios.delete(`${url}/group/user`, {
					params: {
						groupname: link.jiraName,
						username,
					},
					auth: {
						username: config.jira.username,
						password: config.jira.apiToken,
					},
				}).catch((err) => {
					console.log(err.response.data);
					reject(err);
				});
			}
		});
		const addRolesPromise = member.roles.cache.each((role: Discord.Role) => {
			const link = groupLinks.find((item) => item._id === role.id);
			if (link) {
				axios.post(`${url}/group/user`, {
					name: username,
				}, {
					params: {
						groupname: link.jiraName,
					},
					auth: {
						username: config.jira.username,
						password: config.jira.apiToken,
					},
				}).catch((err) => {
					if (/user is already a member/gi.test(err.response?.data.errorMessages[0])) return;

					console.log(err.response.data);
					reject(err);
				});
			}
		});

		await Promise.all(addRolesPromise);
		resolve();
	}).catch(reject);
});

// eslint-disable-next-line max-len
export const updateUserGroupsByKey = (discordId: string, key: string): Promise<void> => new Promise((resolve, reject) => {
	findUserByKey(key).then(async (user) => {
		const guild = await client.guilds.fetch(config.discordServerId).catch(reject);
		// @ts-expect-error guild.members possibly undefined
		const member = await guild?.members.fetch(discordId).catch(reject);
		UserDoc.findById(discordId, (err: any, doc: UserType) => {
			if (err) return;
			if (doc && !doc.mailcowEmail) createEmail(member, doc);
		});

		// @ts-expect-error groupLinks possible void
		const groupLinks: Array<GroupLinkType> = await GroupLink.find({}).lean().exec()
			.catch(reject);

		user.groups.items.forEach((group) => {
			const link = groupLinks.find((item) => item.jiraName === group.name);
			if (link && !member.roles.cache.has(link._id)) {
				axios.delete(`${url}/group/user`, {
					params: {
						groupname: link.jiraName,
						username: user.name,
					},
					auth: {
						username: config.jira.username,
						password: config.jira.apiToken,
					},
				}).catch(reject);
			}
		});
		const addRolesPromise = member.roles.cache.each((role: Discord.Role) => {
			const link = groupLinks.find((item) => item._id === role.id);
			if (link) {
				axios.post(`${url}/group/user`, {
					name: user.name,
				}, {
					params: {
						groupname: link.jiraName,
					},
					auth: {
						username: config.jira.username,
						password: config.jira.apiToken,
					},
				}).catch((err) => {
					if (/user is already a member/gi.test(err.response?.data.errorMessages[0])) return;

					console.log(err.response.data);
					reject(err);
				});
			}
		});

		await Promise.all(addRolesPromise);
		resolve();
	}).catch(reject);
});
