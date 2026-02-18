import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { investors } from '../db/schema.js';

const sqlite = new Database('nodestacker.db');
const db = drizzle(sqlite);

const data = `Jack Altman	Alt Capital
Liz Wessel	First Round
Gaurav Jain	Afore VC
Auren Hoffman	Flex Capital
Howard Lindzon	Social Leverage
Lee Edwards	Root VC
Jack Selby	AZ-VC
Danielle Strachman	1517 Fund
Nico Beradi	Animo VC
Sudarshan Sridharan	SF1
Finn Meeks	South Park Commons
Corinne Riley	Greylock
Colin Gardiner	Yonder Ventures
Shruti Gandhi	array VC
Michael Dempsey	Compound VC
Mike Randall	MonsoonVC
Jed Katz	Javelin Ventures
Christian Kiel	Angel Investor
Adam Besvinick	Looking Glass Capital
Michelle Kwok	Draper
Gregg Scoresby	PHX Ventures
Elizabeth Yin	Hustle Fund
John Diaz	Stone Mountain Ventures
Andrew Gluck	Irrvrnt
Gale Wilkinson	Visualize Venture Group
Ethan Berk	Social Leverage
Sean Lindy	MonsoonVC
Lori Berenberg	Bloomberg Beta
Brendan Rempel	Aglaé Ventures
Jude Gomila	Angel Investor
Hunter Walk	Homebrew
Immad Akhund	Angel Investor
Charles Hudson	Precursor Ventures
Maria Palma	Freestyle Capital
Turner Novak	Banana Capital
Yohei Nakajima	UntappedVC
Jéssica Leão	DecibelVC
Erica Wenger	Park Rangers Capital
Yoni Rechtman	Slow Ventures
Mike Rosengarten	Builders.vc
Joe Magyer	Seaplane Ventures
Anna Rowe	Kickstart Fund
Clay Norris	Outlaw VC
Cam Doody	Brickyard
Aliya Lakhani	Precursor Ventures
Ali Nahm	Tribe Capital
Leeor Mushin	Formation Capital
Nikhil Basu Trivedi	Footwork VC
Jigney Pathak	BBQ Capital
Lee Jacobs	Long Journey Ventures
Jessica Peltz Zatulove	Hannah Grey
Martin Tobias	Incisive Ventures
James Currier	NFX
Nichole Wischoff	Wischoff Ventures
Edward Lando	Pareto Holdings
David Mandel	Emerging Ventures
Maddie Callander	Boost VC
Amy Cheetham	Costanoa
Scott Ferreira	Angel Investor
Ryan Hoover	Weekend Fund
Alex Pall	Mantis VC
Jenny Lefcourt	Freestyle Capital
Natty Zola	Matchstick Ventures
Eric Ries	Angel Investor
Mike Duboe	Greylock
Jeff Morris	Chapter One Ventures
Kenny Tucker	Tucker Seed Fund
Ben Zises	SuperAngel
Zann Ali	2048 Ventures
Pat Matthews	Active Capital
Meltem Demirors	Crucible Capital
Clara Brenner	Urban Innovation Fund
Francis Santora	Angel Investor
Stephen Cole	Angel Investor
AJ Smith	Outlander Labs
Jules Boustouller	Pareto Holdings
Nikunj Kothari	Khosla Ventures
C.C. Gong	Menlo Ventures
Delian Asparouhov	Founders Fund
Kojo Osei	Matrix
Alex Cohen	Angel Investor
Aaron Favreau	AVC
Camilo Acosta	PerceptiveVC
Sean Po	Stage 2 Capital
Dave Fontenot	HF0
Katelyn Donnelly	Avalanche VC
Jordan Odinsky	Ground Up Ventures
Arian Ghashghai	Earthling
Mia Farnham	Precursor Ventures
Trace Cohen	New York Venture Partners
Jay Patil	SwellVC
Scott Belsky	Angel Investor
Andy Weissman	USV
Mike Maccombie	Angel Investor
Ed Suh	Alpine Ventures
Ashley Mayer	Coalition Operators
Ben Lang	Angel Investor
Eric Stromberg	TerrainVC
Tyler Hogge	Pelion
Hugo Amsellem	Intuition VC
Arjun Sethi	Tribe Capital
Ben Casnocha	Village Global
Apoorva Pandhi	Zetta Venture Partners
Michael Shor	Shor Capital
Aashay Sanghvi	Haystack Fund
Josh Constine	Signalfire
Marty Ringlein	Adventure Fund
Niko Bonatsos	Verdict Capital
Annie Case	Kleiner Perkins
Jenny Fielding	Everywhere Ventures
Thomas DelVecchio	Fc Centripetal
Bala Chandrasekaran	Alt Capital
Keith Rabois	Khosla Ventures
Sheel Mohnot	Better Tomorrow Ventures
Leo Polovets	Susa Ventures
Justin Mares	Long Journey Ventures
Joshua Browder	Browder Capital
Stephen Ost	Silicon Desert Ventures
Stephanie Sher	Angel Investor
Joe Cardini	Afore VC
Zak Slayback	1517 Fund
Jason Shuman	Primary Venture Partners
Josh Felser	Angel Investor
Evan Stites-Clayton	HF0
Nate Cooper	Barrell Ventures
Matt Patterson	Brickyard
Eric Jorgenson	Rolling Fun
Astasia Myers	Felicis Ventures
Sara Thomas Deshpande	Maven Ventures
Kevin Herzberg	Pasadena Angels
Sam Attisha	Angel Investor
Randy Holloway	Angel Investor
Adam Burrows	Range Ventures
Tommy Leep	Jetstream
Paige Craig	Outlander Labs
Jake Chapman	Marque Ventures
Daniel Kriozere	Anthropocene Ventures
Kirby Winfield	ascend.vc
Oleksiy Ignatyev	Ride Wave Ventures
Kevin Colas	Explorations Ventures
Ihar Mahaniok	Geek Ventures
Wendell Su	The Healthcare Syndicate
Sviata Luhovets	Geek Ventures
Jason Nelson	Angel Investor
Elizabeth Taylor	PHX Ventures
Tyler Baldridge	AZ-VC
Kelly Schricker	LAUNCH Fund
Ramtin Naimi	Abstract
Aidan Gold	EnsembleVC
Villi Iltchev	Category Ventures
Jonathon Triest	Ludlow Ventures
Paige Doherty	Behind Genius Ventures
Jamesin Seidel	Chapter One Ventures
Ian Rountree	Cantos
Shri Kolanukuduru	Category Ventures
Jed Breed	Breed.VC
Jackson Moses	Silent Ventures
Seth Sivak	Angel Investor
Jonathan Abrams	8-Bit Capital
Shaad Khan	Angel Investor
Brett Calhoun	Redbud VC
Tim Holladay	Spacestation
Clayton Petty	Gradient Ventures
Joe Botsch	Two Sigma Ventures
Nathan Lands	Angel Investor
Micah Rosenbloom	Founder Collective
Ethan Clark	Angel Investor
Ben Ehrlich	Collaborative Fund
Jakob Diepenbrock	Discipulus Ventures
Joshua Schachter	Quine Capital
Yuriy Dovzhansky	Roo Capital
Ben Levy	Geometry
Akash Ramaiah	MXV
Amit Puri	Pureplay VC
Kavon Badie	Mighty Capital`;

const now = new Date().toISOString();

const rows = data.split('\n').map(line => {
  const [name, firm] = line.split('\t');
  return {
    name: name.trim(),
    firm: firm.trim(),
    createdAt: now,
  };
});

console.log(`Importing ${rows.length} investors...`);

const result = db.insert(investors).values(rows).returning({ id: investors.id, name: investors.name });
const inserted = result.all();

console.log(`Successfully imported ${inserted.length} investors`);

sqlite.close();
